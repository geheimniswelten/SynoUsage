package collector

import (
	"context"
	"os"
	"path"
	"strings"
	"synousage/internal/model"
	"syscall"
	"testing"
)

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
`), volume)
	if err != nil {
		t.Fatal(err)
	}
	snapshots, ids := associateSnapshots(volume, items, subs)
	if len(snapshots) != 2 || len(ids) != 2 || ids[0] != 258 || ids[1] != 259 {
		t.Fatalf("unexpected snapshot IDs %v", ids)
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
	summary := applySnapshotQuotas(volume.path, snapshots, ids, groups)
	if summary.Bytes == nil || *summary.Bytes != 512 || summary.Additive || summary.SnapshotCount != 2 || summary.Metric != "btrfs_qgroup_exclusive_lower_bound" {
		t.Fatalf("snapshot summary = %+v", summary)
	}
	if snapshots[0].Bytes == nil || *snapshots[0].Bytes != 0 || snapshots[0].ReferencedBytes == nil || *snapshots[0].ReferencedBytes != 1099511627776 {
		t.Fatalf("zero exclusive bytes were lost: %+v", snapshots[0])
	}
	if _, err := parseQgroups(append(raw, []byte("WARNING: qgroup data inconsistent, rescan recommended\n")...)); err == nil {
		t.Fatal("inconsistent qgroup sizes were accepted")
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
