package collector

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path"
	"strconv"
	"strings"
	"synousage/internal/model"
	"time"
)

const btrfsTimeout = 20 * time.Second

type subvolume struct {
	id               uint64
	uuid, parentUUID string
	path             string
}

type qgroup struct{ referenced, exclusive uint64 }

func snapshotItems(ctx context.Context, volume mount, items []model.Item) ([]model.Item, []string) {
	binary := btrfsBinary()
	if binary == "" {
		return nil, []string{volume.path + ": Btrfs-Snapshots konnten nicht ermittelt werden (Befehl btrfs fehlt)"}
	}
	output, err := runBtrfs(ctx, binary, "subvolume", "list", "-a", "-u", "-q", volume.path)
	if err != nil {
		return nil, []string{fmt.Sprintf("%s: Btrfs-Snapshots konnten nicht ermittelt werden (%v)", volume.path, err)}
	}
	subvolumes, err := parseSubvolumes(output, volume)
	if err != nil {
		return nil, []string{fmt.Sprintf("%s: Btrfs-Snapshots konnten nicht ermittelt werden (%v)", volume.path, err)}
	}
	snapshots, ids := associateSnapshots(volume, items, subvolumes)
	if len(snapshots) == 0 {
		return nil, nil
	}
	output, err = runBtrfs(ctx, binary, "qgroup", "show", "--raw", volume.path)
	var groups map[uint64]qgroup
	if err == nil {
		groups, err = parseQgroups(output)
	}
	summary := applySnapshotQuotas(volume.path, snapshots, ids, groups)
	attachSnapshotSizes(items, snapshots)
	snapshots = append([]model.Item{summary}, snapshots...)
	if err != nil {
		return snapshots, []string{fmt.Sprintf("%s: Btrfs-Snapshotgrößen konnten nicht ermittelt werden (%v)", volume.path, err)}
	}
	return snapshots, nil
}

func attachSnapshotSizes(items, snapshots []model.Item) {
	parents := make(map[string]*model.Item)
	for i := range items {
		if items[i].SnapshotCount > 0 {
			parents[items[i].ID] = &items[i]
		}
	}
	for _, snapshot := range snapshots {
		parent := parents[snapshot.ParentID]
		if parent == nil || snapshot.ExclusiveBytes == nil {
			continue
		}
		if parent.SnapshotBytes == nil {
			parent.SnapshotBytes = new(uint64)
		}
		*parent.SnapshotBytes += *snapshot.ExclusiveBytes
		parent.MeasuredSnapshots++
	}
}

func applySnapshotQuotas(volume string, snapshots []model.Item, ids []uint64, groups map[uint64]qgroup) model.Item {
	summary := makeItem(volume, "snapshots", "Btrfs-Snapshots", volume, "")
	summary.Metric = "btrfs_snapshot"
	summary.SnapshotCount = len(snapshots)
	var exclusive uint64
	known := 0
	for i, id := range ids {
		if group, found := groups[id]; found {
			snapshots[i].Bytes = &group.exclusive
			snapshots[i].ExclusiveBytes = &group.exclusive
			snapshots[i].ReferencedBytes = &group.referenced
			snapshots[i].Metric = "btrfs_qgroup_exclusive"
			snapshots[i].Note = "Btrfs-Qgroup-Bytes, die ausschließlich zu diesem Snapshot gehören."
			// Each leaf qgroup's exclusive extents belong solely to its own
			// subvolume, so the known exclusive extents are disjoint.
			exclusive += group.exclusive
			known++
		}
	}
	if known > 0 {
		summary.Bytes = &exclusive
		summary.ExclusiveBytes = &exclusive
		summary.Metric = "btrfs_qgroup_exclusive_lower_bound"
		summary.Note = fmt.Sprintf("Untergrenze aus den exklusiven Qgroup-Bytes für %d von %d erkannten Snapshots.", known, len(snapshots))
	} else {
		summary.Note = fmt.Sprintf("Die exklusive Belegung ist für alle %d erkannten Snapshots unbekannt.", len(snapshots))
	}
	return summary
}

func btrfsBinary() string {
	for _, p := range []string{"/sbin/btrfs", "/usr/sbin/btrfs", "/bin/btrfs", "/usr/bin/btrfs", "/usr/syno/sbin/btrfs"} {
		if binary, err := exec.LookPath(p); err == nil {
			return binary
		}
	}
	return ""
}

type commandOutput struct{ bytes.Buffer }

func (b *commandOutput) Write(p []byte) (int, error) {
	if b.Len()+len(p) > 16*1024*1024 {
		return 0, errors.New("Die Btrfs-Ausgabe überschreitet 16 MiB")
	}
	return b.Buffer.Write(p)
}

func runBtrfs(ctx context.Context, binary string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, btrfsTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.Env = append(cmd.Environ(), "LC_ALL=C")
	cmd.WaitDelay = 2 * time.Second
	var output commandOutput
	cmd.Stdout, cmd.Stderr = &output, &output
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, err
	}
	return output.Bytes(), nil
}

func parseSubvolumes(output []byte, volume mount) ([]subvolume, error) {
	var subvolumes []subvolume
	scan := bufio.NewScanner(bytes.NewReader(output))
	for scan.Scan() {
		line := scan.Text()
		if !strings.HasPrefix(line, "ID ") {
			continue
		}
		metadata, p, ok := strings.Cut(line, " path ")
		fields := strings.Fields(metadata)
		if !ok || len(fields) < 2 {
			return nil, errors.New("Unbekanntes Format der Btrfs-Subvolume-Liste")
		}
		id, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			return nil, errors.New("Ungültige Subvolume-ID")
		}
		sub := subvolume{id: id}
		for i := 2; i < len(fields)-1; i++ {
			switch fields[i] {
			case "uuid":
				sub.uuid = fields[i+1]
			case "parent_uuid":
				sub.parentUUID = fields[i+1]
			}
		}
		if sub.uuid == "" || sub.parentUUID == "" {
			return nil, errors.New("UUID-Angaben für das Subvolume fehlen")
		}
		if treePath, marked := strings.CutPrefix(p, "<FS_TREE>/"); marked {
			absolute := path.Clean("/" + treePath)
			if !below(volume.root, absolute) {
				continue
			}
			p = strings.TrimPrefix(absolute, strings.TrimSuffix(volume.root, "/")+"/")
		}
		sub.path = path.Join(volume.path, p)
		if below(volume.path, sub.path) {
			subvolumes = append(subvolumes, sub)
		}
	}
	return subvolumes, scan.Err()
}

func parseQgroups(output []byte) (map[uint64]qgroup, error) {
	groups := make(map[uint64]qgroup)
	scan := bufio.NewScanner(bytes.NewReader(output))
	for scan.Scan() {
		line := strings.TrimSpace(scan.Text())
		lower := strings.ToLower(line)
		if strings.HasPrefix(lower, "warning") && (strings.Contains(lower, "inconsist") || strings.Contains(lower, "rescan")) {
			return nil, errors.New("Btrfs-Quotadaten sind inkonsistent oder werden gerade neu ermittelt")
		}
		fields := strings.Fields(line)
		if len(fields) < 3 || !strings.HasPrefix(fields[0], "0/") {
			continue
		}
		id, idErr := strconv.ParseUint(fields[0][2:], 10, 64)
		rfer, rferErr := strconv.ParseUint(fields[1], 10, 64)
		excl, exclErr := strconv.ParseUint(fields[2], 10, 64)
		if idErr == nil && rferErr == nil && exclErr == nil && excl <= rfer {
			groups[id] = qgroup{referenced: rfer, exclusive: excl}
		}
	}
	return groups, scan.Err()
}

func associateSnapshots(volume mount, items []model.Item, subs []subvolume) ([]model.Item, []uint64) {
	byPath := make(map[string]*model.Item)
	for i := range items {
		item := &items[i]
		if (item.Group == "shares" || item.Group == "vmm" || item.Group == "apps" ||
			item.Path == path.Join(volume.path, "@iSCSI")) && item.Metric != "virtual_mount" {
			byPath[item.Path] = item
		}
	}
	byUUID := make(map[string]subvolume)
	for _, sub := range subs {
		if sub.uuid != "-" {
			byUUID[sub.uuid] = sub
		}
	}
	var snapshots []model.Item
	var ids []uint64
	for _, sub := range subs {
		if sub.parentUUID == "-" {
			continue
		}
		var parent *model.Item
		if origin, found := byUUID[sub.parentUUID]; found {
			parent = byPath[origin.path]
			if parent == nil && origin.parentUUID == "-" {
				for p := origin.path; below(volume.path, p); p = path.Dir(p) {
					if parent = byPath[p]; parent != nil {
						break
					}
				}
			}
		}
		if parent == nil {
			parent = dsmSnapshotParent(volume.path, sub.path, byPath)
		}
		if parent == nil {
			continue
		}
		parent.SnapshotCount++
		item := makeItem(volume.path, "snapshots", path.Base(sub.path), sub.path, parent.ID)
		item.Metric = "btrfs_snapshot"
		item.Note = "Die exklusive Belegung dieses Btrfs-Snapshots ist unbekannt."
		snapshots = append(snapshots, item)
		ids = append(ids, sub.id)
	}
	return snapshots, ids
}

func dsmSnapshotParent(volume, p string, byPath map[string]*model.Item) *model.Item {
	if rel, ok := strings.CutPrefix(p, volume+"/@sharesnap/"); ok {
		if share, snapshot, ok := strings.Cut(rel, "/"); ok && snapshot != "" && !strings.Contains(snapshot, "/") {
			if item := byPath[path.Join(volume, share)]; item != nil && item.Group == "shares" {
				return item
			}
			return byPath[path.Join(volume, "@"+share+"@")]
		}
	}
	if rel, ok := strings.CutPrefix(p, volume+"/@iSCSI/Snapshot/BLUN/"); ok {
		if disk, snapshot, ok := strings.Cut(rel, "/"); ok && snapshot != "" && !strings.Contains(snapshot, "/") {
			if item := byPath[path.Join(volume, "@iSCSI/LUN/VDISK_BLUN", disk)]; item != nil {
				return item
			}
			return byPath[path.Join(volume, "@iSCSI")]
		}
	}
	return nil
}
