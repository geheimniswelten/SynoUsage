package collector

import (
	"context"
	"os"
	"path"
	"strings"
	"synousage/internal/model"
	"syscall"
	"testing"
	"time"
)

func TestRetryUsesFreshPlanAfterTimeout(t *testing.T) {
	dir := t.TempDir()
	file := path.Join(dir, "data")
	if err := os.WriteFile(file, []byte("test"), 0600); err != nil {
		t.Fatal(err)
	}
	original := itemPlan{root: makeItem("/volume1", "shares", "test", dir, ""), details: []model.Item{makeItem("/volume1", "shares", "data", file, "parent")}}
	first := copyPlan(original)
	if !measureWithLimit(context.Background(), mount{path: dir, fs: "ext4"}, nil, &first, 0) {
		t.Fatal("expected timeout")
	}
	if first.root.Bytes != nil || first.details[0].Bytes != nil {
		t.Fatal("partial measurements must remain unknown")
	}
	if original.details[0].Note != "" {
		t.Fatal("first attempt modified the retry plan")
	}
	retry := copyPlan(original)
	if measureWithLimit(context.Background(), mount{path: dir, fs: "ext4"}, nil, &retry, time.Second) {
		t.Fatal("retry unexpectedly timed out")
	}
	if retry.root.Bytes == nil || retry.details[0].Bytes == nil || retry.root.Note != "" || retry.details[0].Note != "" {
		t.Fatalf("retry did not replace the incomplete measurement: %+v", retry)
	}
}

func TestParentCancellationIsNotRetryable(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	item := itemPlan{root: makeItem("/volume1", "shares", "test", t.TempDir(), "")}
	if measureWithLimit(ctx, mount{fs: "ext4"}, nil, &item, time.Hour) {
		t.Fatal("cancelled collection must not be retried")
	}
}

func TestRetryPreservesSnapshotInformation(t *testing.T) {
	snapshotBytes, measurement := uint64(42), uint64(200)
	target := model.Item{SnapshotCount: 2, SnapshotBytes: &snapshotBytes, MeasuredSnapshots: 1, Note: "timeout"}
	applyRetryResult(&target, model.Item{Bytes: &measurement, Metric: "allocated_blocks"})
	if target.SnapshotCount != 2 || target.SnapshotBytes == nil || *target.SnapshotBytes != 42 || target.MeasuredSnapshots != 1 || target.Bytes == nil || *target.Bytes != 200 || target.Note != "" {
		t.Fatalf("retry lost data or did not replace the measurement: %+v", target)
	}
}

func TestRefreshVolumeStatsPreservesLastReadingOnError(t *testing.T) {
	dir := t.TempDir()
	missing := path.Join(dir, "volume2")
	previous := model.Volume{ID: "volume2", Capacity: 100, Used: 60, Free: 40}
	volumes := []model.Volume{{Capacity: 1}, previous}
	plans := []volumePlan{{mount: mount{path: dir, fs: "ext4"}}, {mount: mount{path: missing, fs: "ext4"}}}
	warnings := refreshVolumeStats(volumes, plans)
	if volumes[0].Capacity <= 1 {
		t.Fatalf("volume totals were not sampled again: %+v", volumes[0])
	}
	if volumes[1] != previous || len(warnings) != 1 || !strings.HasPrefix(warnings[0], missing+":") {
		t.Fatalf("failed refresh lost the previous volume totals or its warning: %+v, %v", volumes[1], warnings)
	}
}

func TestDSMNativeAllocationExcludesVirtualViews(t *testing.T) {
	volume := path.Join(t.TempDir(), "volume1")
	fixtureFile := func(rel string, size int) string {
		t.Helper()
		p := path.Join(volume, rel)
		if err := os.MkdirAll(path.Dir(p), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, make([]byte, size), 0600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	physical := fixtureFile("ActiveBackupforBusiness/@ActiveBackup/data", 16384)
	if err := os.Link(physical, path.Join(path.Dir(physical), "hardlink")); err != nil {
		t.Fatal(err)
	}
	fixtureFile("ActiveBackupforBusiness/ActiveBackupData/virtual", 1048576)
	fixtureFile("Backups/ActiveBackupData/virtual", 1048576)
	encrypted := fixtureFile("@BackupsCrypto@/ciphertext", 4096)
	fixtureFile("BackupsCrypto/decrypted", 1048576)
	fixtureFile("@docker/btrfs/layer", 1048576)
	fixtureFile("Sharing/#snapshot/virtual", 1048576)
	fixtureFile("@sharesnap/Sharing/snapshot/file", 1048576)
	fixtureFile("@iSCSI/Snapshot/BLUN/vdisk/vsnapshot/file", 1048576)
	disk := fixtureFile("@iSCSI/LUN/VDISK_BLUN/vdisk/physical", 8192)
	fixtureFile("@appstore/ActiveBackup/daemon", 4096)
	if err := os.Symlink(path.Join(volume, "@docker"), path.Join(volume, "Sharing", "symlink")); err != nil {
		t.Fatal(err)
	}

	mounts := make(map[string]mount)
	for rel, fs := range map[string]string{
		"ActiveBackupforBusiness/ActiveBackupData": "fuse.synodedup-fused",
		"Backups/ActiveBackupData":                 "fuse.synodedup-fused",
		"BackupsCrypto":                            "ecryptfs",
		"@docker":                                  "btrfs",
		"@docker/btrfs":                            "btrfs",
		"Sharing/#snapshot":                        "btrfs",
	} {
		p := path.Join(volume, rel)
		mounts[p] = mount{path: p, fs: fs}
	}
	plans, err := planItems(volume, mounts)
	if err != nil {
		t.Fatal(err)
	}
	items := make(map[string]model.Item)
	for _, plan := range plans {
		if !plan.skipScan {
			measureItem(context.Background(), mount{path: volume, fs: "btrfs"}, mounts, &plan)
		}
		items[plan.root.Path] = plan.root
		for _, item := range append(plan.details, plan.virtual...) {
			items[item.Path] = item
		}
	}

	assertAllocation := func(rel string, want uint64) model.Item {
		t.Helper()
		item := items[path.Join(volume, rel)]
		if item.Bytes == nil || *item.Bytes != want || item.Additive || item.Metric != "allocated_blocks" {
			t.Fatalf("%s = %+v; want allocated blocks %d", rel, item, want)
		}
		return item
	}
	detail := assertAllocation("ActiveBackupforBusiness/@ActiveBackup", allocated(t, physical, path.Dir(physical)))
	share := assertAllocation("ActiveBackupforBusiness", *detail.Bytes+allocated(t, path.Join(volume, "ActiveBackupforBusiness")))
	if detail.ParentID != share.ID {
		t.Fatal("physical Active Backup detail lost its parent")
	}
	for _, p := range []string{"ActiveBackupforBusiness/ActiveBackupData", "Backups/ActiveBackupData"} {
		if item := items[path.Join(volume, p)]; item.Bytes != nil || item.Metric != "virtual_mount" || item.ParentID == "" {
			t.Fatalf("virtual view %s = %+v", p, item)
		}
	}
	if item := assertAllocation("@BackupsCrypto@", allocated(t, encrypted, path.Dir(encrypted))); item.Name != "BackupsCrypto" || item.Group != "shares" {
		t.Fatalf("encrypted backing share = %+v", item)
	}
	if item := items[path.Join(volume, "BackupsCrypto")]; item.ID != "" {
		t.Fatalf("encrypted mount alias was measured: %+v", item)
	}
	if item := items[path.Join(volume, "@docker")]; item.Group != "docker" || item.Bytes != nil || item.Note == "" {
		t.Fatalf("Docker mounted storage should be unknown: %+v", item)
	}
	assertAllocation("Sharing", allocated(t, path.Join(volume, "Sharing"), path.Join(volume, "Sharing/symlink")))
	san := assertAllocation("@iSCSI", allocated(t, path.Join(volume, "@iSCSI/LUN"), path.Join(volume, "@iSCSI")))
	vmm := assertAllocation("@iSCSI/LUN/VDISK_BLUN", allocated(t, disk, path.Dir(disk), path.Dir(path.Dir(disk))))
	if san.Group != "other" || vmm.Group != "vmm" || items[path.Dir(disk)].ParentID != vmm.ID {
		t.Fatalf("SAN and VMM storage not separated: %+v, %+v", san, vmm)
	}
	if item := items[path.Join(volume, "@appstore/ActiveBackup")]; item.Group != "apps" || item.Name != "Active Backup for Business" || item.ParentID == "" {
		t.Fatalf("package detail = %+v", item)
	}
}

func TestVolumeWithoutOptionalPackages(t *testing.T) {
	volume := path.Join(t.TempDir(), "volume1")
	if err := os.MkdirAll(path.Join(volume, "@iSCSI", "LUN", "BLUN"), 0700); err != nil {
		t.Fatal(err)
	}
	plans, err := planItems(volume, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(plans) != 1 || plans[0].root.Group != "other" || plans[0].root.Name != "iSCSI / SAN" {
		t.Fatalf("a SAN-only volume produced optional package records: %+v", plans)
	}
}

func allocated(t *testing.T, files ...string) uint64 {
	t.Helper()
	var size uint64
	for _, p := range files {
		info, err := os.Lstat(p)
		if err != nil {
			t.Fatal(err)
		}
		size += uint64(info.Sys().(*syscall.Stat_t).Blocks) * 512
	}
	return size
}

func TestSnapshotInventoryAndQuota(t *testing.T) {
	volume := mount{path: "/volume1", root: "/"}
	items := []model.Item{
		makeItem(volume.path, "shares", "Sharing", "/volume1/Sharing", ""),
		makeItem(volume.path, "vmm", "vdisk", "/volume1/@iSCSI/LUN/VDISK_BLUN/vdisk", "parent"),
	}
	subs, err := parseSubvolumes([]byte(`ID 256 gen 17 top level 5 parent_uuid - uuid share path Sharing
ID 257 gen 17 top level 5 parent_uuid - uuid vdisk path @iSCSI/LUN/VDISK_BLUN/vdisk
ID 258 gen 17 top level 5 parent_uuid share uuid sharesnap path <FS_TREE>/@sharesnap/Sharing/GMT+01-2026.11.10-15.30.01
ID 259 gen 17 top level 5 parent_uuid vdisk uuid vdisksnap path @iSCSI/Snapshot/BLUN/vdisk/vsnapshot
ID 260 gen 17 top level 5 parent_uuid other uuid dockerlayer path @docker/btrfs/subvolumes/layer
ID 261 gen 17 top level 5 parent_uuid share uuid clone path SharingClone
`), volume)
	if err != nil {
		t.Fatal(err)
	}
	snapshots, refs := associateSnapshots(volume, items, subs, snapshotPaths(volume.path, subs, nil))
	if len(snapshots) != 2 || len(refs) != 2 || refs[0].id != 258 || refs[1].id != 259 {
		t.Fatalf("unexpected snapshot IDs %v", refs)
	}
	for i, item := range items {
		snapshot := snapshots[i]
		if item.SnapshotCount != 1 || snapshot.ParentID != item.ID || snapshot.Group != "snapshots" || snapshot.Bytes != nil || snapshot.Additive {
			t.Fatalf("parent %+v; snapshot %+v", item, snapshot)
		}
	}
	raw := []byte("qgroupid rfer excl\n-------- ---- ----\n0/258 1099511627776 0\n0/259 4096 512\n1/300 8192 8192\n")
	groups, err := parseQgroups(raw)
	if err != nil || len(groups) != 2 || groups[258] != (qgroup{1099511627776, 0}) || groups[259] != (qgroup{4096, 512}) {
		t.Fatalf("qgroups = %+v, %v", groups, err)
	}
	summary := applySnapshotQuotas(volume.path, snapshots, refs, groups)
	if summary.Bytes == nil || *summary.Bytes != 512 || summary.Additive || summary.SnapshotCount != 2 || summary.Metric != "btrfs_qgroup_exclusive_lower_bound" {
		t.Fatalf("snapshot summary = %+v", summary)
	}
	if snapshots[0].Bytes == nil || *snapshots[0].Bytes != 0 || snapshots[0].ReferencedBytes == nil || *snapshots[0].ReferencedBytes != 1099511627776 {
		t.Fatalf("zero exclusive bytes were lost: %+v", snapshots[0])
	}
	if _, err := parseQgroups(append(raw, []byte("WARNING: qgroup data inconsistent, rescan recommended\n")...)); err == nil {
		t.Fatal("inconsistent qgroup sizes were accepted")
	}
	if !hasExclusiveQgroup(groups) || hasExclusiveQgroup(map[uint64]qgroup{258: {1099511627776, 0}}) {
		t.Fatal("DSM's referenced-only qgroup counters must not stand for measured exclusive bytes")
	}
}

func TestSnapshotSourcesOnDSMVolume(t *testing.T) {
	volume := mount{path: "/volume1", root: "/@syno"}
	sharing := makeItem(volume.path, "shares", "Sharing", "/volume1/Sharing", "")
	items := []model.Item{sharing}
	subs, err := parseSubvolumes([]byte(`ID 262 gen 6537399 top level 257 parent_uuid - uuid share path @syno/Sharing
ID 363 gen 6537399 top level 275 parent_uuid - uuid container path <FS_TREE>/@syno/@sharesnap/Sharing
ID 284021 gen 6537358 top level 363 parent_uuid share uuid first path <FS_TREE>/@syno/@sharesnap/Sharing/GMT+01-2026.11.11-16.17.47
ID 284022 gen 6537368 top level 363 parent_uuid share uuid second path <FS_TREE>/@syno/@sharesnap/Sharing/GMT+01-2026.11.11-16.19.39
`), volume)
	if err != nil {
		t.Fatal(err)
	}
	snapshots, refs := associateSnapshots(volume, items, subs, snapshotPaths(volume.path, subs, nil))
	if len(snapshots) != 2 || items[0].SnapshotCount != 2 || snapshots[0].ParentID != sharing.ID {
		t.Fatalf("unexpected source association: %+v %+v", items, snapshots)
	}
	data := snapshotData{
		total: 42, bySource: map[string]uint64{sharing.Path: 42},
		referenced: map[uint64]uint64{284021: 42, 284022: 42},
	}
	summary := applySnapshotData(volume.path, snapshots, refs, &data)
	rows := snapshotSources(summary, items, snapshots, refs, &data)
	if summary.Bytes == nil || *summary.Bytes != 42 || summary.VolumeID != "volume1" || summary.Metric != snapshotDataMetric || summary.SnapshotCount != 2 {
		t.Fatalf("invalid volume summary: %+v", summary)
	}
	if len(rows) != 1 || rows[0].ParentID != summary.ID || rows[0].Path != sharing.Path || rows[0].Bytes == nil || *rows[0].Bytes != 42 {
		t.Fatalf("invalid source breakdown: %+v", rows)
	}
	if items[0].SnapshotBytes == nil || *items[0].SnapshotBytes != 42 || items[0].SnapshotMetric != snapshotDataMetric || items[0].MeasuredSnapshots != 2 {
		t.Fatalf("invalid source totals: %+v", items[0])
	}
	for _, snap := range snapshots {
		if snap.ExclusiveBytes == nil || *snap.ExclusiveBytes != 0 || snap.ReferencedBytes == nil || *snap.ReferencedBytes != 42 {
			t.Fatalf("a shared extent cannot be exclusive to a snapshot: %+v", snap)
		}
	}
}

func TestReadOnlySnapshotsOfAppAndDockerSubvolumes(t *testing.T) {
	volume := mount{path: "/volume1", root: "/@syno"}
	app := makeItem(volume.path, "apps", "Synology Drive", "/volume1/@appdata/SynologyDrive", "packages")
	docker := makeItem(volume.path, "docker", "Docker-Daten", "/volume1/@docker", "")
	items := []model.Item{app, docker}
	subs, err := parseSubvolumes([]byte(`ID 257 gen 3 top level 5 parent_uuid - uuid volume path <FS_TREE>/@syno
ID 258 gen 3 top level 257 parent_uuid - uuid app path @syno/@appdata/SynologyDrive
ID 259 gen 3 top level 257 parent_uuid base uuid image path @syno/@docker/btrfs/subvolumes/cache
ID 260 gen 3 top level 257 parent_uuid app uuid appsnap path @syno/@appdata/SynologyDrive/backup
ID 261 gen 3 top level 257 parent_uuid image uuid imagesnap path @syno/Snapshots/image-backup
ID 262 gen 3 top level 257 parent_uuid active uuid containerd-layer path @syno/@docker/containerd/io.containerd.snapshotter.v1.btrfs/snapshots/15
ID 263 gen 3 top level 257 parent_uuid volume uuid volumesnap path @syno/Volume-Backup
ID 264 gen 3 top level 257 parent_uuid app uuid clone path @syno/Live-App-Clone
`), volume)
	if err != nil {
		t.Fatal(err)
	}
	roots := make(map[uint64]btrfsRoot)
	for _, id := range []uint64{259, 260, 261, 262, 263} {
		roots[id] = btrfsRoot{flags: btrfsRootReadOnly}
	}
	paths := snapshotPaths(volume.path, subs, roots)
	snapshots, refs := associateSnapshots(volume, items, subs, paths)
	if len(snapshots) != 3 || refs[0].sourcePath != app.Path || refs[0].sourceName != app.Name || snapshots[0].ParentID != app.ID ||
		refs[1].sourcePath != "/volume1/@docker/btrfs/subvolumes/cache" || snapshots[1].ParentID != docker.ID || refs[2].sourcePath != volume.path {
		t.Fatalf("unexpected snapshot sources: %+v %+v", refs, snapshots)
	}
	appPlan := itemPlan{root: app, details: []model.Item{{Path: "/volume1/@appdata/SynologyDrive/backup/data"}}}
	clonePlan := itemPlan{root: model.Item{Path: "/volume1/Live-App-Clone"}}
	backupPlan := itemPlan{root: model.Item{Path: "/volume1/Volume-Backup"}}
	plans := excludeSnapshotPaths([]itemPlan{appPlan, clonePlan, backupPlan}, paths)
	if len(plans) != 2 || len(plans[0].details) != 0 || !plans[0].snapshotPaths["/volume1/@appdata/SynologyDrive/backup"] || plans[1].root.Path != clonePlan.root.Path {
		t.Fatalf("incorrect live-scan exclusions: %+v", plans)
	}
}

func TestDeletedSubvolumeExclusiveLowerBound(t *testing.T) {
	volume := mount{path: "/volume1", root: "/@syno", fs: "btrfs"}
	output := []byte(`ID 3277 gen 1 top level 257 parent_uuid - uuid parent path @syno/@deleted_subvol/ZEC1ho
ID 21173 gen 1 top level 3277 parent_uuid parent uuid snap1 path <FS_TREE>/@syno/@deleted_subvol/ZEC1ho/first
ID 21264 gen 1 top level 3277 parent_uuid parent uuid snap2 path <FS_TREE>/@syno/@deleted_subvol/ZEC1ho/second
`)
	subs, err := parseSubvolumes(output, volume)
	if err != nil || len(subs) != 3 {
		t.Fatalf("subvolumes: %+v, %v", subs, err)
	}
	if subs[0].path != "/volume1/@deleted_subvol/ZEC1ho" || subs[1].path != "/volume1/@deleted_subvol/ZEC1ho/first" {
		t.Fatalf("paths: %+v", subs)
	}
	parent := makeItem(volume.path, "snapshots", "Gelöschte Subvolumes", "/volume1/@deleted_subvol", "")
	groups := map[uint64]qgroup{3277: {1000, 100}, 21173: {500, 20}}
	children := measureDeletedSubvolumes(volume.path, &parent, subs, groups)
	if len(children) != 3 || parent.Bytes == nil || *parent.Bytes != 120 || parent.SnapshotCount != 3 || parent.MeasuredSnapshots != 2 || parent.Metric != "btrfs_qgroup_exclusive_lower_bound" || !strings.Contains(parent.Note, "Untergrenze") {
		t.Fatalf("parent: %+v, children: %+v", parent, children)
	}
	if children[2].Bytes != nil || children[2].Metric != "btrfs_snapshot" {
		t.Fatalf("missing qgroup must remain unknown: %+v", children[2])
	}
	items := []model.Item{parent, makeItem(volume.path, "shares", "original", "/volume1/original", "")}
	ordinary, _ := associateSnapshots(volume, items, subs, snapshotPaths(volume.path, subs, nil))
	if len(ordinary) != 0 {
		t.Fatalf("deleted snapshots must not be counted again: %+v", ordinary)
	}
	unknown := makeItem(volume.path, "snapshots", "Gelöschte Subvolumes", parent.Path, "")
	measureDeletedSubvolumes(volume.path, &unknown, subs, nil)
	if unknown.Bytes != nil || !strings.Contains(unknown.Note, "unbekannt") {
		t.Fatalf("no qgroups must not imply zero: %+v", unknown)
	}
}

func TestAllocationCancellationKeepsBytesUnknown(t *testing.T) {
	volume := t.TempDir()
	plan := itemPlan{root: makeItem(volume, "shares", "share", volume, "")}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	measureItem(ctx, mount{path: volume, fs: "ext4"}, nil, &plan)
	if plan.root.Bytes != nil || plan.root.Additive || !strings.Contains(plan.root.Note, "context canceled") {
		t.Fatalf("canceled allocation = %+v", plan.root)
	}
}
