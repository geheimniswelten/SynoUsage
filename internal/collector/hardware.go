package collector

import (
	"bufio"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"synousage/internal/model"
)

func readText(name string) string {
	b, err := os.ReadFile(name)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func sectors(name string) uint64 {
	n, err := strconv.ParseUint(readText(name), 10, 64)
	if err != nil || n > ^uint64(0)/512 {
		return 0
	}
	return n * 512
}

func systemVersions(proc, etc string) (dsm, kernel string) {
	kernel = readText(filepath.Join(proc, "sys/kernel/osrelease"))
	// On DSM, /etc.defaults is a sibling of /etc.
	for _, dir := range []string{filepath.Clean(etc) + ".defaults", etc} {
		fields := map[string]string{}
		for _, line := range strings.Split(readText(filepath.Join(dir, "VERSION")), "\n") {
			key, value, ok := strings.Cut(line, "=")
			if ok {
				fields[strings.TrimSpace(key)] = strings.Trim(strings.TrimSpace(value), "\"'")
			}
		}
		dsm = fields["productversion"]
		if dsm == "" {
			continue
		}
		if build := fields["buildnumber"]; build != "" {
			dsm += "-" + build
		}
		if update := fields["smallfixnumber"]; update != "" && update != "0" {
			dsm += " Update " + update
		}
		break
	}
	return dsm, kernel
}

// SystemVersions reads the running system without waiting for a storage scan.
func SystemVersions() (dsm, kernel string) {
	return systemVersions("/proc", "/etc")
}

func hardwareInfo(sys, proc, etc string) model.HardwareInfo {
	result := model.HardwareInfo{At: time.Now().UTC().Format(time.RFC3339), Devices: []model.BlockDevice{}}
	result.Model = readText(filepath.Join(proc, "sys/kernel/syno_hw_version"))
	if result.Model == "" {
		result.Model = readText(filepath.Join(sys, "class/dmi/id/product_name"))
	}
	result.DSM, result.Kernel = systemVersions(proc, etc)
	if f, err := os.Open(filepath.Join(proc, "cpuinfo")); err == nil {
		s := bufio.NewScanner(f)
		for s.Scan() {
			key, value, ok := strings.Cut(s.Text(), ":")
			if !ok {
				continue
			}
			switch strings.TrimSpace(key) {
			case "processor":
				result.CPUs++
			case "model name":
				if result.CPU == "" {
					result.CPU = strings.TrimSpace(value)
				}
			}
		}
		f.Close()
	}
	if khz, err := strconv.ParseUint(readText(filepath.Join(sys, "devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq")), 10, 64); err == nil {
		result.MaxMHz = khz / 1000
	}
	if f, err := os.Open(filepath.Join(proc, "meminfo")); err == nil {
		s := bufio.NewScanner(f)
		for s.Scan() {
			if strings.HasPrefix(s.Text(), "MemTotal:") {
				fields := strings.Fields(s.Text())
				if len(fields) > 1 {
					n, _ := strconv.ParseUint(fields[1], 10, 64)
					result.Memory = n * 1024
				}
				break
			}
		}
		f.Close()
	}
	base := filepath.Join(sys, "class/block")
	entries, err := os.ReadDir(base)
	if err != nil {
		result.Warnings = append(result.Warnings, "Blockgeräte konnten nicht ausgelesen werden.")
		return result
	}
	mounts := map[string][]string{}
	mountSources := map[string][]string{}
	if f, err := os.Open(filepath.Join(proc, "self/mountinfo")); err == nil {
		if all, err := parseMounts(f); err == nil {
			for _, m := range all {
				if volumePath.MatchString(m.path) || m.path == "/" {
					mounts[m.device] = append(mounts[m.device], m.path)
					mountSources[filepath.Base(m.source)] = append(mountSources[filepath.Base(m.source)], m.path)
				}
			}
		}
		f.Close()
	}
	if f, err := os.Open(filepath.Join(proc, "swaps")); err == nil {
		s := bufio.NewScanner(f)
		for s.Scan() {
			fields := strings.Fields(s.Text())
			if len(fields) > 0 && strings.HasPrefix(fields[0], "/dev/") {
				name := filepath.Base(fields[0])
				mountSources[name] = append(mountSources[name], "Swap (aktiv)")
			}
		}
		f.Close()
	}
	for _, entry := range entries {
		name := entry.Name()
		p := filepath.Join(base, name)
		kind := ""
		switch {
		case strings.HasPrefix(name, "md") && readText(filepath.Join(p, "md/level")) != "":
			kind = "raid"
		case strings.HasPrefix(name, "dm-"):
			kind = "mapper"
		case strings.HasPrefix(name, "sd"), strings.HasPrefix(name, "nvme"), strings.HasPrefix(name, "vd"), strings.HasPrefix(name, "xvd"), strings.HasPrefix(name, "mmcblk"), strings.HasPrefix(name, "synoboot"):
			if readText(filepath.Join(p, "partition")) != "" {
				kind = "partition"
			} else {
				kind = "disk"
			}
		}
		if kind == "" {
			continue
		}
		d := model.BlockDevice{Name: name, Kind: kind, Size: sectors(filepath.Join(p, "size")), Mounts: mounts[readText(filepath.Join(p, "dev"))]}
		if len(d.Mounts) == 0 {
			d.Mounts = mountSources[name]
		}
		if kind == "disk" {
			d.Model = strings.TrimSpace(readText(filepath.Join(p, "device/vendor")) + " " + readText(filepath.Join(p, "device/model")))
			switch readText(filepath.Join(p, "queue/rotational")) {
			case "1":
				d.Medium = "rotierend"
			case "0":
				d.Medium = "nicht rotierend"
			}
			if real, err := filepath.EvalSymlinks(p); err == nil && strings.Contains(real, "/usb") {
				d.Transport = "usb"
			}
		}
		if kind == "partition" {
			d.Start = sectors(filepath.Join(p, "start"))
			if target, err := filepath.EvalSymlinks(p); err == nil {
				d.Parent = filepath.Base(filepath.Dir(target))
			}
		}
		if kind == "raid" {
			d.Level = readText(filepath.Join(p, "md/level"))
			d.State = readText(filepath.Join(p, "md/array_state"))
		}
		if kind == "mapper" {
			d.Label = readText(filepath.Join(p, "dm/name"))
			if len(d.Mounts) == 0 {
				d.Mounts = mountSources[d.Label]
			}
		}
		if kind == "raid" || kind == "mapper" {
			if children, err := os.ReadDir(filepath.Join(p, "slaves")); err == nil {
				for _, child := range children {
					d.Members = append(d.Members, child.Name())
				}
				sort.Strings(d.Members)
			}
		}
		sort.Strings(d.Mounts)
		result.Devices = append(result.Devices, d)
	}
	return result
}

// Hardware inventory is saved independently of the historical usage runs.
func HardwareInfo() model.HardwareInfo {
	info := hardwareInfo("/sys", "/proc", "/etc")
	info.Root = rootFilesystemInfo()
	path, err := exec.LookPath("synopartition")
	if err != nil {
		if _, statErr := os.Stat("/usr/syno/sbin/synopartition"); statErr == nil {
			path, err = "/usr/syno/sbin/synopartition", nil
		}
	}
	if err == nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if out, err := exec.CommandContext(ctx, path, "--list").Output(); err == nil && len(out) <= 64<<10 {
			info.PartitionLayouts = strings.TrimSpace(string(out))
		}
		cancel()
	}
	readLVM := func(tool, columns string) ([][]string, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		args := []string{"--noheadings", "--separator", "|", "--units", "b", "--nosuffix", "-o", columns}
		if tool == "lvs" {
			args = append([]string{"-a"}, args...)
		}
		data, err := exec.CommandContext(ctx, tool, args...).Output()
		if err != nil {
			return nil, err
		}
		var rows [][]string
		for _, line := range strings.Split(string(data), "\n") {
			if strings.TrimSpace(line) == "" {
				continue
			}
			row := strings.Split(line, "|")
			for i := range row {
				row[i] = strings.TrimSpace(row[i])
			}
			rows = append(rows, row)
		}
		return rows, nil
	}
	bytes := func(s string) uint64 { n, _ := strconv.ParseUint(strings.TrimSpace(s), 10, 64); return n }
	if rows, err := readLVM("pvs", "pv_name,vg_name,pv_size,pv_free"); err == nil {
		for _, r := range rows {
			if len(r) >= 4 {
				info.PVs = append(info.PVs, model.LVMPhysical{Name: r[0], Group: r[1], Size: bytes(r[2]), Free: bytes(r[3])})
			}
		}
	} else {
		info.Warnings = append(info.Warnings, "LVM-Physische Volumes konnten nicht ermittelt werden.")
	}
	if rows, err := readLVM("lvs", "lv_name,vg_name,lv_size,devices"); err == nil {
		for _, r := range rows {
			if len(r) >= 4 {
				info.LVM = append(info.LVM, model.LVMVolume{Name: r[0], Group: r[1], Size: bytes(r[2]), Devices: r[3]})
			}
		}
	} else {
		info.Warnings = append(info.Warnings, "LVM-Volumes konnten nicht ermittelt werden.")
	}
	return info
}
