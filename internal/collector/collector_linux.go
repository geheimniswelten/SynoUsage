package collector

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path"
	"slices"
	"strings"
	"syscall"
	"time"

	"synousage/internal/model"
)

const treeTimeout = 15 * time.Minute
const retryTreeTimeout = 24 * time.Hour

type volumePlan struct {
	mount
	items     []itemPlan
	snapshots snapshotInventory
}

type itemPlan struct {
	root          model.Item
	details       []model.Item
	virtual       []model.Item
	skipScan      bool
	skipPath      string
	snapshotPaths map[string]bool
}

type pendingRetry struct {
	volume mount
	item   itemPlan
	index  int
}

// Save an independent copy: the first measurement modifies its details in place.
func copyPlan(item itemPlan) itemPlan {
	item.details = append([]model.Item(nil), item.details...)
	item.virtual = append([]model.Item(nil), item.virtual...)
	return item
}

func applyRetryResult(target *model.Item, measured model.Item) {
	target.Bytes, target.Metric, target.Note, target.Additive = measured.Bytes, measured.Metric, measured.Note, measured.Additive
}

func measureWithLimit(ctx context.Context, volume mount, mounts map[string]mount, item *itemPlan, limit time.Duration) bool {
	scope, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	measureItem(scope, volume, mounts, item)
	return errors.Is(scope.Err(), context.DeadlineExceeded) && ctx.Err() == nil
}

func Collect(ctx context.Context, progress func(phase, current string, done, total int), checkpoint func(model.Run)) (run model.Run, err error) {
	at := time.Now().UTC()
	var suffix [8]byte
	_, _ = rand.Read(suffix[:])
	run = model.Run{
		ID: at.Format("20060102T150405Z") + "-" + hex.EncodeToString(suffix[:]), At: at,
		Volumes: make([]model.Volume, 0), Items: make([]model.Item, 0),
	}
	if progress == nil {
		progress = func(string, string, int, int) {}
	}
	if checkpoint == nil {
		checkpoint = func(model.Run) {}
	}
	progress("discover", "", 0, 0)
	file, err := os.Open("/proc/self/mountinfo")
	if err != nil {
		return run, fmt.Errorf("Mount-Tabelle lesen: %w", err)
	}
	mounts, err := parseMounts(file)
	file.Close()
	if err != nil {
		return run, fmt.Errorf("Mount-Tabelle lesen: %w", err)
	}

	plans := make([]volumePlan, 0)
	total := 0
	for _, m := range nativeVolumes(mounts) {
		if err := ctx.Err(); err != nil {
			return run, err
		}
		v, err := volumeStats(m)
		if err != nil {
			run.Warnings = append(run.Warnings, m.path+": "+err.Error())
			continue
		}
		run.Volumes = append(run.Volumes, v)
		items, err := planItems(m.path, mounts)
		if err != nil {
			run.Warnings = append(run.Warnings, fmt.Sprintf("%s: Verzeichnisse konnten nicht ermittelt werden (%v)", m.path, err))
		}
		plan := volumePlan{mount: m, items: items}
		if m.fs == "btrfs" {
			plan.snapshots, err = discoverSnapshots(ctx, m)
			if err != nil && ctx.Err() == nil {
				run.Warnings = append(run.Warnings, fmt.Sprintf("%s: Btrfs-Snapshots konnten nicht vollständig ermittelt werden (%v).", m.path, err))
			}
			plan.items = excludeSnapshotPaths(plan.items, plan.snapshots.paths)
		}
		plans = append(plans, plan)
		total += len(plan.items)
	}
	if len(plans) == 0 {
		return run, errors.New("Die Mount-Tabelle enthält keine lesbaren DSM-Datenvolumes")
	}
	// A scan can take hours. Refresh the volume totals before publishing the
	// final result, including when the caller saves a cancelled scan.
	defer func() {
		run.Warnings = append(run.Warnings, refreshVolumeStats(run.Volumes, plans)...)
	}()
	publish := func() {
		warnings := refreshVolumeStats(run.Volumes, plans)
		current := run
		if len(warnings) > 0 {
			current.Warnings = append(slices.Clone(run.Warnings), warnings...)
		}
		checkpoint(current)
	}

	// Publish all discovered paths before scanning, so unfinished work remains visible.
	for _, plan := range plans {
		for _, item := range plan.items {
			root := item.root
			if !item.skipScan {
				addNote(&root, "Messung steht noch aus.")
			}
			run.Items = append(run.Items, root)
			run.Items = append(run.Items, item.details...)
			run.Items = append(run.Items, item.virtual...)
		}
	}
	publish()

	done, next := 0, 0
	var retries []pendingRetry
	for _, plan := range plans {
		start := next
		for _, item := range plan.items {
			if err := ctx.Err(); err != nil {
				return run, err
			}
			index := next
			next += 1 + len(item.details) + len(item.virtual)
			progress("scan", item.root.Path, done, total)
			if !item.skipScan {
				original := copyPlan(item)
				if measureWithLimit(ctx, plan.mount, mounts, &item, treeTimeout) {
					retries = append(retries, pendingRetry{volume: plan.mount, item: original, index: index})
					progress("retry_pending", item.root.Path, done, total)
				} else if item.root.Bytes == nil && ctx.Err() == nil {
					run.Warnings = append(run.Warnings, item.root.Path+": "+item.root.Note)
				}
			}
			run.Items[index] = item.root
			copy(run.Items[index+1:], item.details)
			copy(run.Items[index+1+len(item.details):], item.virtual)
			publish()
			if err := ctx.Err(); err != nil {
				return run, err
			}
			done++
		}
		if plan.fs == "btrfs" {
			progress("snapshots", plan.path, done, total)
			snapshots, warnings := snapshotItems(ctx, plan.mount, run.Items[start:next], plan.snapshots)
			run.Items = append(run.Items, snapshots...)
			run.Warnings = append(run.Warnings, warnings...)
			publish()
			if err := ctx.Err(); err != nil {
				return run, err
			}
		}
	}
	for i, retry := range retries {
		if err := ctx.Err(); err != nil {
			return run, err
		}
		progress("retry", retry.item.root.Path, i, len(retries))
		measureWithLimit(ctx, retry.volume, mounts, &retry.item, retryTreeTimeout)
		if err := ctx.Err(); err != nil {
			return run, err
		}
		applyRetryResult(&run.Items[retry.index], retry.item.root)
		for j, detail := range retry.item.details {
			applyRetryResult(&run.Items[retry.index+1+j], detail)
		}
		if retry.item.root.Bytes == nil {
			run.Warnings = append(run.Warnings, retry.item.root.Path+": "+retry.item.root.Note)
		}
		publish()
	}
	for _, item := range run.Items {
		if item.Group != "docker" || item.ParentID != "" || path.Base(item.Path) != "@docker" {
			continue
		}
		if err := ctx.Err(); err != nil {
			return run, err
		}
		progress("docker", item.Path, done, total)
		images, warning := dockerImages(ctx, item)
		run.Items = append(run.Items, images...)
		if warning != "" {
			run.Warnings = append(run.Warnings, warning)
		}
		publish()
	}
	return run, ctx.Err()
}

func volumeStats(m mount) (model.Volume, error) {
	var stats syscall.Statfs_t
	if err := syscall.Statfs(m.path, &stats); err != nil {
		return model.Volume{}, fmt.Errorf("Kapazität konnte nicht ermittelt werden: %w", err)
	}
	blockSize := uint64(stats.Frsize)
	if blockSize == 0 {
		blockSize = uint64(stats.Bsize)
	}
	if stats.Bfree > stats.Blocks || stats.Bavail > stats.Bfree || blockSize == 0 {
		return model.Volume{}, errors.New("Ungültige Kapazitätswerte des Dateisystems")
	}
	return model.Volume{
		ID: path.Base(m.path), Name: "Volume " + strings.TrimPrefix(path.Base(m.path), "volume"), FS: m.fs,
		Capacity: stats.Blocks * blockSize, Used: (stats.Blocks - stats.Bfree) * blockSize,
		Free: stats.Bavail * blockSize,
	}, nil
}

func refreshVolumeStats(volumes []model.Volume, plans []volumePlan) []string {
	var warnings []string
	for i, plan := range plans {
		volume, err := volumeStats(plan.mount)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("%s: Volume-Werte konnten nicht aktualisiert werden (%v).", plan.path, err))
			continue
		}
		volumes[i] = volume
	}
	return warnings
}

func makeItem(volume, group, name, p, parent string) model.Item {
	hash := sha256.Sum256([]byte(group + "\x00" + p))
	return model.Item{
		ID: hex.EncodeToString(hash[:12]), VolumeID: path.Base(volume), Group: group,
		Name: name, Path: p, ParentID: parent, Metric: "unknown",
	}
}

func addNote(item *model.Item, note string) {
	if item.Note != "" {
		item.Note += " "
	}
	item.Note += note
}

func excludeSnapshotPaths(items []itemPlan, snapshotPaths map[string]bool) []itemPlan {
	if len(snapshotPaths) == 0 {
		return items
	}
	insideSnapshot := func(p string) bool {
		for ; p != "/" && p != "."; p = path.Dir(p) {
			if snapshotPaths[p] {
				return true
			}
		}
		return false
	}
	items = slices.DeleteFunc(items, func(item itemPlan) bool { return insideSnapshot(item.root.Path) })
	for i := range items {
		item := &items[i]
		item.snapshotPaths = snapshotPaths
		item.details = slices.DeleteFunc(item.details, func(detail model.Item) bool { return insideSnapshot(detail.Path) })
		item.virtual = slices.DeleteFunc(item.virtual, func(detail model.Item) bool { return insideSnapshot(detail.Path) })
	}
	return items
}

func planItems(volume string, mounts map[string]mount) ([]itemPlan, error) {
	entries, err := os.ReadDir(volume)
	if err != nil {
		return nil, err
	}
	items := make([]itemPlan, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		p := path.Join(volume, name)
		if snapshotDirectory(volume, p) || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		group, title, note := classify(name, entry.IsDir())
		item := itemPlan{root: makeItem(volume, group, title, p, "")}
		item.root.Note = note
		if name == "@deleted_subvol" && mounts[volume].fs == "btrfs" {
			item.skipScan = true
			item.root.Metric = "btrfs_snapshot"
			item.root.Note = "Interner Bereich für frühere Subvolumes; exklusive Qgroup-Werte werden gesondert ermittelt."
			items = append(items, item)
			continue
		}
		if name == "@docker" && hasMount(p, mounts) {
			item.root.Note = "Die physische Belegung der separaten Docker-Mounts ist offen. Image-Details sind verfügbar, wenn der lokale Docker-Dienst läuft."
			item.skipScan = true
			items = append(items, item)
			continue
		}
		if _, mounted := mounts[p]; mounted {
			continue
		}
		if entry.IsDir() {
			planDetails(volume, name, mounts, &item)
		}
		if name == "@iSCSI" {
			if disks, ok := planVMM(volume, p, mounts); ok {
				item.skipPath = disks.root.Path
				item.root.Note = "SAN-Speicher und Dienstdateien. Die erkannten VM-Datenträger werden separat gemessen."
				items = append(items, disks)
			}
		}
		for mp, m := range mounts {
			if m.fs == "fuse.synodedup-fused" && below(p, mp) {
				alias := makeItem(volume, group, path.Base(mp), mp, item.root.ID)
				alias.Metric = "virtual_mount"
				alias.Note = "Virtuelle Active-Backup-Ansicht. Die Messung endet an diesem Mount."
				item.virtual = append(item.virtual, alias)
			}
		}
		slices.SortFunc(item.virtual, func(a, b model.Item) int { return strings.Compare(a.Path, b.Path) })
		items = append(items, item)
	}
	return items, nil
}

func hasMount(p string, mounts map[string]mount) bool {
	for mp := range mounts {
		if p == mp || below(p, mp) {
			return true
		}
	}
	return false
}

var dsmApps = map[string]string{
	"@appstore": "Installierte Pakete", "@appdata": "Paketdaten", "@appconf": "Paketkonfiguration",
	"@apphome": "Paket-Arbeitsverzeichnisse", "@apptemp": "Temporäre Paketdateien",
	"@database": "DSM-Datenbanken", "@synologydrive": "Synology Drive", "@cloudstation": "Cloud Station",
	"@ActiveBackup": "Active Backup for Business", "@surveillance": "Surveillance Station",
}

var packageNames = map[string]string{
	"ActiveBackup": "Active Backup for Business", "ContainerManager": "Container Manager",
	"HyperBackup": "Hyper Backup", "ReplicationService": "Replication Service", "SnapshotReplication": "Snapshot Replication",
	"SynologyDrive": "Synology Drive Server", "Virtualization": "Virtual Machine Manager",
}

func classify(name string, directory bool) (group, title, note string) {
	switch name {
	case "@deleted_subvol":
		return "snapshots", "Gelöschte Subvolumes", ""
	case "@docker":
		return "docker", "Docker-Daten", ""
	case "@iSCSI":
		return "other", "iSCSI / SAN", ""
	}
	if title, ok := dsmApps[name]; ok {
		return "apps", title, ""
	}
	if directory && len(name) > 2 && name[0] == '@' && strings.HasSuffix(name, "@") {
		return "shares", name[1 : len(name)-1], "Ablage der verschlüsselten Freigabe."
	}
	if directory && !strings.HasPrefix(name, "@") && !strings.HasPrefix(name, ".") && name != "lost+found" {
		return "shares", name, ""
	}
	return "other", name, ""
}

func planDetails(volume, name string, mounts map[string]mount, plan *itemPlan) {
	root := plan.root.Path
	add := func(title, p string) {
		plan.details = append(plan.details, makeItem(volume, plan.root.Group, title, p, plan.root.ID))
	}
	switch name {
	case "ActiveBackupforBusiness":
		p := path.Join(root, "@ActiveBackup")
		if _, mounted := mounts[p]; mounted {
			return
		}
		if info, err := os.Lstat(p); err == nil && info.IsDir() {
			add("Active-Backup-Daten", p)
		}
	case "@appstore", "@appdata":
		entries, err := readDirectory(root)
		if err != nil {
			return
		}
		for _, child := range entries {
			childPath := path.Join(root, child.Name())
			if _, mounted := mounts[childPath]; mounted || !child.IsDir() {
				continue
			}
			title := child.Name()
			if caption := packageNames[title]; caption != "" {
				title = caption
			}
			add(title, childPath)
		}
	}
}

func planVMM(volume, iscsi string, mounts map[string]mount) (itemPlan, bool) {
	lun := path.Join(iscsi, "LUN")
	p := path.Join(lun, "VDISK_BLUN")
	for _, component := range []string{lun, p} {
		if _, mounted := mounts[component]; mounted {
			return itemPlan{}, false
		}
		info, err := os.Lstat(component)
		if err != nil || !info.IsDir() {
			return itemPlan{}, false
		}
	}
	entries, err := readDirectory(p)
	if err != nil {
		return itemPlan{}, false
	}
	plan := itemPlan{root: makeItem(volume, "vmm", "Virtuelle Datenträger", p, "")}
	for _, entry := range entries {
		disk := path.Join(p, entry.Name())
		if _, mounted := mounts[disk]; mounted || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		plan.details = append(plan.details, makeItem(volume, "vmm", entry.Name(), disk, plan.root.ID))
	}
	return plan, len(plan.details) > 0
}
