package collector

import (
	"reflect"
	"strings"
	"testing"
)

func TestNativeVolumesAndMountPaths(t *testing.T) {
	mounts, err := parseMounts(strings.NewReader(`
37 20 0:44 / /volume1 rw,relatime shared:5 - btrfs /dev/mapper/cachedev_0 rw
38 37 0:45 /@sharesnap/Sharing /volume1/Sharing/#snapshot rw - btrfs /dev/mapper/cachedev_0 rw
39 37 0:46 / /volume1/BackupsCrypto rw - ecryptfs /volume1/@BackupsCrypto@ rw
40 37 0:47 / /volume1/ActiveBackupforBusiness/ActiveBackupData rw - fuse.synodedup-fused synodedup-fused rw
41 37 0:48 /@docker /volume1/@docker rw - btrfs /dev/mapper/cachedev_0 rw
42 41 0:49 /@docker/btrfs /volume1/@docker/btrfs rw - btrfs /dev/mapper/cachedev_0 rw
43 20 8:1 / /volume2 rw - ext4 /dev/sda1 rw
44 20 0:44 /Sharing /volume3 rw - btrfs /dev/mapper/cachedev_0 rw
45 20 0:60 / /volumeUSB1/usbshare rw - ext4 /dev/sdb1 rw
46 20 0:61 / /volume4 rw - fuse.something fuse.something rw
47 37 0:62 / /volume1/Backups\040With\040Spaces rw - tmpfs tmpfs rw
48 50 0:64 / /volume5 rw - tmpfs tmpfs rw
50 20 0:63 / /volume5 rw - btrfs /dev/mapper/cachedev_1 rw
`[1:]))
	if err != nil {
		t.Fatal(err)
	}
	var paths []string
	for _, volume := range nativeVolumes(mounts) {
		paths = append(paths, volume.path)
	}
	if !reflect.DeepEqual(paths, []string{"/volume1", "/volume2"}) {
		t.Fatalf("native volumes = %v", paths)
	}
	if m := mounts["/volume1/Backups With Spaces"]; m.fs != "tmpfs" {
		t.Fatalf("escaped mount point was not parsed: %+v", m)
	}
	if mounts["/volume1/@docker/btrfs"].root != "/@docker/btrfs" {
		t.Fatal("Docker mount root was lost")
	}
}
