package collector

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path"
	"slices"
	"strconv"
	"strings"
	"synousage/internal/model"
	"time"
)

const btrfsTimeout = 20 * time.Second

const snapshotDataMetric = "btrfs_snapshot_data"
const snapshotLowerBoundMetric = "btrfs_qgroup_exclusive_lower_bound"

type subvolume struct {
	id               uint64
	uuid, parentUUID string
	path             string
}

type qgroup struct{ referenced, exclusive uint64 }

type snapshotInventory struct {
	binary string
	subs   []subvolume
	paths  map[string]bool
}

type snapshotRef struct {
	id                    uint64
	sourceKey, sourcePath string
	sourceName            string
}

func discoverSnapshots(ctx context.Context, volume mount) (snapshotInventory, error) {
	binary := btrfsBinary()
	if binary == "" {
		return snapshotInventory{}, errors.New("Befehl btrfs fehlt")
	}
	output, err := runBtrfs(ctx, binary, "subvolume", "list", "-a", "-u", "-q", volume.path)
	if err != nil {
		return snapshotInventory{}, err
	}
	subvolumes, err := parseSubvolumes(output, volume)
	if err != nil {
		return snapshotInventory{}, err
	}
	scope, cancel := context.WithTimeout(ctx, btrfsTimeout)
	defer cancel()
	var roots map[uint64]btrfsRoot
	dir, err := openDirectory(volume.path)
	if err == nil {
		defer dir.Close()
		reader := btrfsTreeReader{file: dir, buf: make([]byte, btrfsSearchBufferSize)}
		roots, err = reader.activeRoots(scope)
	}
	if err != nil {
		roots = nil
		err = fmt.Errorf("Btrfs-Subvolume-Flags konnten nicht gelesen werden (%w)", err)
	}
	return snapshotInventory{binary: binary, subs: subvolumes, paths: snapshotPaths(volume.path, subvolumes, roots)}, err
}

func snapshotPaths(volume string, subs []subvolume, roots map[uint64]btrfsRoot) map[string]bool {
	paths := make(map[string]bool)
	deleted := path.Join(volume, "@deleted_subvol")
	for _, sub := range subs {
		if sub.path == deleted || below(deleted, sub.path) || dockerLayerSubvolume(volume, sub.path) {
			continue
		}
		readOnly := roots[sub.id].flags&btrfsRootReadOnly != 0
		managed := managedSnapshotPath(volume, sub.path)
		if (managed && (sub.parentUUID != "-" || readOnly)) || (readOnly && sub.parentUUID != "-") {
			paths[sub.path] = true
		}
	}
	return paths
}

func managedSnapshotPath(volume, p string) bool {
	return below(path.Join(volume, "@sharesnap"), p) || below(path.Join(volume, "@iSCSI/Snapshot"), p)
}

func dockerLayerSubvolume(volume, p string) bool {
	parent := path.Dir(p)
	if parent == path.Join(volume, "@docker/btrfs/subvolumes") {
		return true
	}
	if path.Base(path.Dir(parent)) == "io.containerd.snapshotter.v1.btrfs" {
		switch path.Base(parent) {
		case "active", "snapshots", "view":
			return true
		}
	}
	return false
}

func snapshotItems(ctx context.Context, volume mount, items []model.Item, inventory snapshotInventory) ([]model.Item, []string) {
	snapshots, refs := associateSnapshots(volume, items, inventory.subs, inventory.paths)
	deletedPath := path.Join(volume.path, "@deleted_subvol")
	var deleted *model.Item
	for i := range items {
		if items[i].Path == deletedPath {
			deleted = &items[i]
			break
		}
	}
	var deletedSubs []subvolume
	if deleted != nil {
		for _, sub := range inventory.subs {
			if below(deletedPath, sub.path) {
				deletedSubs = append(deletedSubs, sub)
			}
		}
	}
	if len(snapshots) == 0 && len(deletedSubs) == 0 {
		if deleted != nil && inventory.binary != "" {
			deleted.Note = "Keine enthaltenen Subvolumes gefunden; Belegung nicht ermittelt."
		}
		return nil, nil
	}

	var data *snapshotData
	var warnings []string
	if len(snapshots) > 0 {
		measured, err := snapshotDataForVolume(ctx, volume.path, snapshots, refs)
		if err == nil {
			data = &measured
		} else if ctx.Err() == nil {
			warnings = append(warnings, fmt.Sprintf("%s: Snapshot-Datenblöcke konnten nicht ermittelt werden (%v).", volume.path, err))
		}
	}
	var groups map[uint64]qgroup
	if ctx.Err() == nil && ((data == nil && len(snapshots) > 0) || len(deletedSubs) > 0) {
		output, err := runBtrfs(ctx, inventory.binary, "qgroup", "show", "--raw", volume.path)
		if err == nil {
			groups, err = parseQgroups(output)
			if err == nil && !hasExclusiveQgroup(groups) {
				err = errors.New("keine exklusiven Qgroup-Werte verfügbar")
				groups = nil
			}
		}
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("%s: Exklusive Btrfs-Qgroup-Werte konnten nicht ermittelt werden (%v).", volume.path, err))
		}
	}
	if len(snapshots) > 0 {
		var summary model.Item
		if data != nil {
			summary = applySnapshotData(volume.path, snapshots, refs, data)
		} else {
			summary = applySnapshotQuotas(volume.path, snapshots, refs, groups)
		}
		sources := snapshotSources(summary, items, snapshots, refs, data)
		snapshots = append([]model.Item{summary}, snapshots...)
		snapshots = append(snapshots, sources...)
	}
	if deleted != nil && len(deletedSubs) > 0 {
		snapshots = append(snapshots, measureDeletedSubvolumes(volume.path, deleted, deletedSubs, groups)...)
		if deleted.MeasuredSnapshots < len(deletedSubs) {
			warnings = append(warnings, fmt.Sprintf("%s: Exklusive Qgroup-Werte für %d von %d Subvolumes fehlen.", deletedPath, len(deletedSubs)-deleted.MeasuredSnapshots, len(deletedSubs)))
		}
	}
	return snapshots, warnings
}

func snapshotDataForVolume(ctx context.Context, volume string, snapshots []model.Item, refs []snapshotRef) (snapshotData, error) {
	scope, cancel := context.WithTimeout(ctx, retryTreeTimeout)
	defer cancel()
	dir, err := openDirectory(volume)
	if err != nil {
		return snapshotData{}, err
	}
	defer dir.Close()
	reader := btrfsTreeReader{file: dir, buf: make([]byte, btrfsSearchBufferSize)}
	roots, err := reader.activeRoots(scope)
	if err != nil {
		return snapshotData{}, err
	}
	sources := make(map[uint64]string, len(refs))
	for i, ref := range refs {
		if !managedSnapshotPath(volume, snapshots[i].Path) && roots[ref.id].flags&btrfsRootReadOnly == 0 {
			return snapshotData{}, fmt.Errorf("Snapshot-Baum %d ist nicht mehr schreibgeschützt", ref.id)
		}
		sources[ref.id] = ref.sourceKey
	}
	return measureSnapshotData(scope, &reader, roots, sources, snapshotExtentsPerPass)
}

func hasExclusiveQgroup(groups map[uint64]qgroup) bool {
	// Some DSM volumes track referenced bytes but leave every exclusive
	// counter at zero. Full accounting includes at least the tree metadata.
	for _, group := range groups {
		if group.exclusive > 0 {
			return true
		}
	}
	return false
}

func measureDeletedSubvolumes(volume string, parent *model.Item, subs []subvolume, groups map[uint64]qgroup) []model.Item {
	var total uint64
	known := 0
	children := make([]model.Item, 0, len(subs))
	parent.SnapshotCount = len(subs)
	for _, sub := range subs {
		item := makeItem(volume, "snapshots", path.Base(sub.path), sub.path, parent.ID)
		item.Metric = "btrfs_snapshot"
		item.Note = "Exklusive Belegung dieses Subvolumes unbekannt."
		if group, ok := groups[sub.id]; ok {
			item.Bytes, item.ExclusiveBytes, item.ReferencedBytes = &group.exclusive, &group.exclusive, &group.referenced
			item.Metric = "btrfs_qgroup_exclusive"
			item.Note = "Exklusive Btrfs-Qgroup-Belegung dieses Subvolumes."
			total += group.exclusive
			known++
		}
		children = append(children, item)
	}
	parent.MeasuredSnapshots = known
	if known > 0 {
		parent.Bytes, parent.ExclusiveBytes = &total, &total
		parent.Metric = snapshotLowerBoundMetric
		parent.Note = fmt.Sprintf("Untergrenze: Summe exklusiver Qgroup-Werte für %d von %d Subvolumes. Untereinander geteilte Blöcke und andere Dateien können fehlen.", known, len(subs))
	} else {
		parent.Note = fmt.Sprintf("Exklusive Belegung für %d enthaltene Subvolumes unbekannt; Qgroup-Werte fehlen.", len(subs))
	}
	return children
}

func snapshotSources(summary model.Item, items, snapshots []model.Item, refs []snapshotRef, data *snapshotData) []model.Item {
	parents := make(map[string]*model.Item)
	for i := range items {
		if items[i].SnapshotCount > 0 {
			parents[items[i].ID] = &items[i]
		}
	}
	bySource := make(map[string]*model.Item)
	owners := make(map[string]string)
	for i := range snapshots {
		snapshot := &snapshots[i]
		ref := refs[i]
		key := ref.sourceKey
		source := bySource[key]
		if source == nil {
			row := makeItem(summary.Path, "snapshots", ref.sourceName, summary.Path+"\x00"+key, summary.ID)
			row.Path = ref.sourcePath
			row.Metric = snapshotLowerBoundMetric
			source = &row
			bySource[key] = source
			owners[key] = snapshot.ParentID
		}
		source.SnapshotCount++
		if snapshot.ExclusiveBytes != nil {
			if source.Bytes == nil {
				source.Bytes = new(uint64)
			}
			*source.Bytes += *snapshot.ExclusiveBytes
			source.MeasuredSnapshots++
		}
		if snapshot.ParentID == "" {
			snapshot.ParentID = summary.ID
		}
	}
	rows := make([]model.Item, 0, len(bySource)+1)
	for key, row := range bySource {
		if data != nil {
			size := data.bySource[key]
			row.Bytes = &size
			row.Metric = snapshotDataMetric
			row.Note = "Datenblöcke, die nur Snapshots dieser Quelle halten."
			if row.Path == "" {
				row.Note = "Datenblöcke in Snapshots ohne zugeordnete Quelle."
			}
		}
		if parent := parents[owners[key]]; parent != nil {
			parent.SnapshotMetric = row.Metric
			parent.MeasuredSnapshots += row.MeasuredSnapshots
			if row.Bytes != nil {
				if parent.SnapshotBytes == nil {
					parent.SnapshotBytes = new(uint64)
				}
				*parent.SnapshotBytes += *row.Bytes
			}
		}
		rows = append(rows, *row)
	}
	slices.SortFunc(rows, func(a, b model.Item) int {
		if c := strings.Compare(a.Name, b.Name); c != 0 {
			return c
		}
		return strings.Compare(a.Path, b.Path)
	})
	if data != nil && data.shared > 0 {
		row := makeItem(summary.Path, "snapshots", "Quellübergreifend geteilt", summary.Path+"\x00shared", summary.ID)
		row.Path, row.Metric, row.Bytes = "", snapshotDataMetric, &data.shared
		row.Note = "Datenblöcke, die nur Snapshots mehrerer Quellen gemeinsam halten."
		rows = append(rows, row)
	}
	return rows
}

func applySnapshotData(volume string, snapshots []model.Item, refs []snapshotRef, data *snapshotData) model.Item {
	summary := makeItem(volume, "snapshots", "Btrfs-Snapshots", volume, "")
	summary.Metric, summary.Bytes = snapshotDataMetric, &data.total
	summary.SnapshotCount, summary.MeasuredSnapshots = len(snapshots), len(snapshots)
	summary.Note = "Datenblöcke, die nur Snapshots halten, einschließlich gemeinsam gehaltener Blöcke. Dateisystem-Metadaten bleiben in der übrigen Belegung."
	for i, ref := range refs {
		exclusive, referenced := data.exclusive[ref.id], data.referenced[ref.id]
		snapshot := &snapshots[i]
		snapshot.Bytes, snapshot.ExclusiveBytes, snapshot.ReferencedBytes = &exclusive, &exclusive, &referenced
		snapshot.Metric = snapshotDataMetric
		snapshot.Note = "Datenblöcke, die dieser Snapshot exklusiv belegt."
	}
	return summary
}

func applySnapshotQuotas(volume string, snapshots []model.Item, refs []snapshotRef, groups map[uint64]qgroup) model.Item {
	summary := makeItem(volume, "snapshots", "Btrfs-Snapshots", volume, "")
	summary.Metric = "btrfs_snapshot"
	summary.SnapshotCount = len(snapshots)
	var exclusive uint64
	known := 0
	for i, ref := range refs {
		if group, found := groups[ref.id]; found {
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
		summary.MeasuredSnapshots = known
		summary.Metric = snapshotLowerBoundMetric
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
			if absolute == volume.root {
				p = ""
			} else if below(volume.root, absolute) {
				p = strings.TrimPrefix(absolute, strings.TrimSuffix(volume.root, "/")+"/")
			} else {
				continue
			}
		} else if root := strings.Trim(volume.root, "/"); root != "" {
			if p == root {
				p = ""
			} else {
				p = strings.TrimPrefix(p, root+"/")
			}
		}
		sub.path = path.Join(volume.path, p)
		if sub.path == volume.path || below(volume.path, sub.path) {
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

func associateSnapshots(volume mount, items []model.Item, subs []subvolume, paths map[string]bool) ([]model.Item, []snapshotRef) {
	byPath := make(map[string]*model.Item)
	for i := range items {
		item := &items[i]
		if item.Group != "snapshots" && item.Metric != "virtual_mount" {
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
	var refs []snapshotRef
	for _, sub := range subs {
		if !paths[sub.path] {
			continue
		}
		ref := snapshotRef{id: sub.id, sourceKey: sub.parentUUID, sourceName: "Quelle nicht ermittelt"}
		if ref.sourceKey == "-" {
			ref.sourceKey = sub.path
		}
		var parent *model.Item
		if origin := snapshotOrigin(sub.parentUUID, byUUID, paths); origin != "" {
			ref.sourcePath = origin
			for p := origin; p == volume.path || below(volume.path, p); p = path.Dir(p) {
				if parent = byPath[p]; parent != nil {
					break
				}
			}
		}
		if ref.sourcePath == "" {
			ref.sourcePath, parent = dsmSnapshotSource(volume.path, sub.path, byPath)
		}
		if ref.sourcePath != "" {
			ref.sourceKey = ref.sourcePath
			ref.sourceName = path.Base(ref.sourcePath)
			if ref.sourcePath == volume.path {
				ref.sourceName = "Volume " + strings.TrimPrefix(path.Base(volume.path), "volume")
			}
		}
		var parentID string
		if parent != nil {
			parent.SnapshotCount++
			parentID = parent.ID
			if parent.Path == ref.sourcePath {
				ref.sourceName = parent.Name
			} else if parent.Group == "apps" || parent.Group == "docker" || parent.Group == "vmm" {
				ref.sourceName = parent.Name + " · " + ref.sourceName
			}
		}
		item := makeItem(volume.path, "snapshots", path.Base(sub.path), sub.path, parentID)
		item.Metric = "btrfs_snapshot"
		item.Note = "Die exklusive Belegung dieses Btrfs-Snapshots ist unbekannt."
		snapshots = append(snapshots, item)
		refs = append(refs, ref)
	}
	return snapshots, refs
}

func snapshotOrigin(uuid string, byUUID map[string]subvolume, paths map[string]bool) string {
	for range len(byUUID) {
		origin, found := byUUID[uuid]
		if !found {
			return ""
		}
		if !paths[origin.path] {
			return origin.path
		}
		uuid = origin.parentUUID
	}
	return ""
}

func dsmSnapshotSource(volume, p string, byPath map[string]*model.Item) (string, *model.Item) {
	if rel, ok := strings.CutPrefix(p, volume+"/@sharesnap/"); ok {
		if share, snapshot, ok := strings.Cut(rel, "/"); ok && snapshot != "" && !strings.Contains(snapshot, "/") {
			sourcePath := path.Join(volume, share)
			if item := byPath[sourcePath]; item != nil && item.Group == "shares" {
				return sourcePath, item
			}
			if item := byPath[path.Join(volume, "@"+share+"@")]; item != nil {
				return item.Path, item
			}
			return sourcePath, nil
		}
	}
	if rel, ok := strings.CutPrefix(p, volume+"/@iSCSI/Snapshot/BLUN/"); ok {
		if disk, snapshot, ok := strings.Cut(rel, "/"); ok && snapshot != "" && !strings.Contains(snapshot, "/") {
			sourcePath := path.Join(volume, "@iSCSI/LUN/VDISK_BLUN", disk)
			if item := byPath[sourcePath]; item != nil {
				return sourcePath, item
			}
			return "", byPath[path.Join(volume, "@iSCSI")]
		}
	}
	return "", nil
}
