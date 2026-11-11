package collector

import (
	"os"
	"path/filepath"
	"testing"
)

func TestHardwareInventoryReadsRAIDAndMemory(t *testing.T) {
	root := t.TempDir()
	write := func(name, text string) {
		t.Helper()
		p := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(text), 0644); err != nil {
			t.Fatal(err)
		}
	}
	write("proc/sys/kernel/syno_hw_version", "DS918+\n")
	write("proc/sys/kernel/osrelease", "4.4.302+\n")
	write("proc/cpuinfo", "processor: 0\nmodel name: Test CPU\nprocessor: 1\n")
	write("proc/meminfo", "MemTotal: 1024 kB\n")
	write("etc.defaults/VERSION", "productversion=\"7.2.2\"\nbuildnumber=\"72806\"\nsmallfixnumber=\"3\"\n")
	write("sys/class/block/sda/size", "1000\n")
	write("sys/class/block/sda/device/model", "Test disk\n")
	write("sys/class/block/md2/size", "800\n")
	write("sys/class/block/md2/md/level", "raid5\n")
	write("sys/class/block/md2/md/array_state", "clean\n")
	write("sys/class/block/md2/slaves/sda5", "")
	write("proc/swaps", "Filename Type Size Used Priority\n/dev/md2 partition 123 0 -2\n")
	write("sys/class/block/sda/queue/rotational", "1\n")
	write("sys/class/block/dm-0/size", "800\n")
	write("sys/class/block/dm-0/dm/name", "cachedev_1\n")
	write("sys/class/block/dm-0/dev", "253:0\n")
	write("sys/class/block/dm-0/slaves/md2", "")
	write("proc/self/mountinfo", "1 0 0:44 / /volume1 rw - btrfs /dev/mapper/cachedev_1 rw\n")
	info := hardwareInfo(filepath.Join(root, "sys"), filepath.Join(root, "proc"), filepath.Join(root, "etc"))
	if info.Model != "DS918+" || info.DSM != "7.2.2-72806 Update 3" || info.Kernel != "4.4.302+" || info.CPUs != 2 || info.Memory != 1024*1024 {
		t.Fatalf("unexpected system: %+v", info)
	}
	byName := map[string]int{}
	for i, d := range info.Devices {
		byName[d.Name] = i
	}
	if len(info.Devices) != 3 {
		t.Fatalf("unexpected devices: %+v", info.Devices)
	}
	md := info.Devices[byName["md2"]]
	if md.Kind != "raid" || md.Level != "raid5" || md.Size != 800*512 || len(md.Members) != 1 || md.Members[0] != "sda5" || len(md.Mounts) != 1 || md.Mounts[0] != "Swap (aktiv)" {
		t.Fatalf("unexpected RAID: %+v", md)
	}
	if info.Devices[byName["sda"]].Medium != "rotierend" {
		t.Fatal("rotation property missing")
	}
	dm := info.Devices[byName["dm-0"]]
	if len(dm.Mounts) != 1 || dm.Mounts[0] != "/volume1" || len(dm.Members) != 1 || dm.Members[0] != "md2" {
		t.Fatalf("unexpected mapping: %+v", dm)
	}
}

func TestHardwareInventoryPartitionParentAndOffsets(t *testing.T) {
	root := t.TempDir()
	sys := filepath.Join(root, "sys")
	actual := filepath.Join(sys, "devices", "pci0000", "block", "sda")
	class := filepath.Join(sys, "class", "block")
	if err := os.MkdirAll(filepath.Join(actual, "sda1"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(class, 0755); err != nil {
		t.Fatal(err)
	}
	for _, f := range []struct{ name, value string }{{"size", "10000"}, {"sda1/size", "3000"}, {"sda1/start", "2048"}, {"sda1/partition", "1"}} {
		if err := os.WriteFile(filepath.Join(actual, filepath.FromSlash(f.name)), []byte(f.value), 0644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(actual, filepath.Join(class, "sda")); err != nil {
		t.Skipf("directory symlinks unavailable: %v", err)
	}
	if err := os.Symlink(filepath.Join(actual, "sda1"), filepath.Join(class, "sda1")); err != nil {
		t.Skipf("directory symlinks unavailable: %v", err)
	}
	info := hardwareInfo(sys, filepath.Join(root, "proc"), filepath.Join(root, "etc"))
	for _, device := range info.Devices {
		if device.Name == "sda1" {
			if device.Kind != "partition" || device.Parent != "sda" || device.Start != 2048*512 || device.Size != 3000*512 {
				t.Fatalf("unexpected partition: %+v", device)
			}
			return
		}
	}
	t.Fatalf("partition not found: %+v", info.Devices)
}
