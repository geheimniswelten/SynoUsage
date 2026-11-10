package collector

import (
	"bufio"
	"fmt"
	"io"
	"path"
	"regexp"
	"slices"
	"strings"
)

type mount struct {
	id, parent, device, root, path, fs, source string
}

var volumePath = regexp.MustCompile(`^/volume[1-9][0-9]*$`)

var mountEscapes = strings.NewReplacer(`\040`, " ", `\011`, "\t", `\012`, "\n", `\134`, `\`)

func parseMounts(r io.Reader) (map[string]mount, error) {
	mounts := make(map[string]mount)
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	for scanner.Scan() {
		before, after, ok := strings.Cut(scanner.Text(), " - ")
		left, right := strings.Fields(before), strings.Fields(after)
		if !ok || len(left) < 6 || len(right) < 3 {
			return nil, fmt.Errorf("Ungültiger Eintrag in der Mount-Tabelle")
		}
		m := mount{
			id: left[0], parent: left[1], device: left[2], root: mountEscapes.Replace(left[3]),
			path: mountEscapes.Replace(left[4]), fs: right[0], source: mountEscapes.Replace(right[1]),
		}
		// A child overmount at the same path hides the lower entry. If the
		// relationship is ambiguous, err on the side of excluding the path.
		if prior, exists := mounts[m.path]; exists {
			if prior.parent == m.id {
				continue
			}
			if m.parent != prior.id {
				m.fs = "unknown"
			}
		}
		mounts[m.path] = m
	}
	return mounts, scanner.Err()
}

func nativeVolumes(mounts map[string]mount) []mount {
	volumes := make([]mount, 0)
	for _, m := range mounts {
		if volumePath.MatchString(m.path) && (m.fs == "btrfs" || m.fs == "ext4") {
			volumes = append(volumes, m)
		}
	}
	slices.SortFunc(volumes, func(a, b mount) int {
		if len(a.path) != len(b.path) {
			return len(a.path) - len(b.path)
		}
		return strings.Compare(a.path, b.path)
	})
	// Btrfs subvolumes can have distinct anonymous device numbers despite
	// sharing the same backing source. Prefer a top-level mount to an alias.
	seen := make(map[string]bool)
	for _, m := range volumes {
		if m.root == "/" {
			seen[mountIdentity(m)] = true
		}
	}
	top := make(map[string]bool)
	return slices.DeleteFunc(volumes, func(m mount) bool {
		key := mountIdentity(m)
		if m.root == "/" {
			duplicate := top[key]
			top[key] = true
			return duplicate
		}
		duplicate := seen[key]
		seen[key] = true
		return duplicate
	})
}

func mountIdentity(m mount) string {
	if strings.HasPrefix(m.source, "/dev/") {
		return m.fs + ":" + m.source
	}
	return m.fs + ":" + m.device
}

func below(root, p string) bool {
	return strings.HasPrefix(p, strings.TrimSuffix(root, "/")+"/")
}

func snapshotDirectory(volume, p string) bool {
	rel, ok := strings.CutPrefix(p, strings.TrimSuffix(volume, "/")+"/")
	return ok && (rel == "@sharesnap" || rel == "@iSCSI/Snapshot" || path.Base(rel) == "#snapshot" && strings.Count(rel, "/") == 1)
}
