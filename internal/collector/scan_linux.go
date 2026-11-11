package collector

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"slices"
	"strings"
	"syscall"

	"synousage/internal/model"
)

type inode struct{ device, number uint64 }

type allocation struct {
	bytes    uint64
	links    map[inode]bool
	err      error
	seen     bool
	excluded bool
}

func (a *allocation) add(info os.FileInfo) {
	a.seen = true
	stat := info.Sys().(*syscall.Stat_t)
	if !info.IsDir() && stat.Nlink > 1 {
		if a.links == nil {
			a.links = make(map[inode]bool)
		}
		key := inode{uint64(stat.Dev), uint64(stat.Ino)}
		if a.links[key] {
			return
		}
		a.links[key] = true
	}
	a.bytes += uint64(stat.Blocks) * 512
}

type treeScan struct {
	ctx           context.Context
	volume        mount
	mounts        map[string]mount
	skipPath      string
	snapshotPaths map[string]bool
	root          allocation
	details       map[string]*allocation
}

func measureItem(ctx context.Context, volume mount, mounts map[string]mount, plan *itemPlan) {
	scan := treeScan{ctx: ctx, volume: volume, mounts: mounts, skipPath: plan.skipPath, snapshotPaths: plan.snapshotPaths, details: make(map[string]*allocation)}
	for _, detail := range plan.details {
		scan.details[detail.Path] = &allocation{}
	}
	info, err := os.Lstat(plan.root.Path)
	if err == nil && info.Mode()&os.ModeSymlink != 0 {
		err = errors.New("Der Pfad wurde durch einen symbolischen Link ersetzt")
	}
	if err != nil {
		scan.root.err = err
	} else {
		scan.visit(plan.root.Path, info, nil)
	}
	if err := ctx.Err(); err != nil {
		scan.root.err = err
		for _, detail := range scan.details {
			detail.err = err
		}
	}
	applyAllocation(&plan.root, &scan.root, volume.fs)
	for i := range plan.details {
		detail := &plan.details[i]
		applyAllocation(detail, scan.details[detail.Path], volume.fs)
	}
}

func (s *treeScan) visit(p string, info os.FileInfo, detail *allocation) {
	if s.ctx.Err() != nil {
		return
	}
	s.root.add(info)
	if detail != nil {
		detail.add(info)
	}
	if !info.IsDir() {
		return
	}
	dir, err := openDirectory(p)
	if err != nil {
		s.recordError(detail, err)
		return
	}
	defer dir.Close()
	for s.ctx.Err() == nil {
		entries, err := dir.ReadDir(256)
		for _, entry := range entries {
			if s.ctx.Err() != nil {
				return
			}
			child := path.Join(p, entry.Name())
			if child == s.skipPath || s.snapshotPaths[child] || snapshotDirectory(s.volume.path, child) {
				continue
			}
			if _, mounted := s.mounts[child]; mounted {
				s.root.excluded = true
				if detail != nil {
					detail.excluded = true
				}
				continue
			}
			childDetail := detail
			if d := s.details[child]; d != nil {
				childDetail = d
			}
			childInfo, err := entry.Info()
			if err != nil {
				if !errors.Is(err, os.ErrNotExist) {
					s.recordError(childDetail, err)
				}
				continue
			}
			s.visit(child, childInfo, childDetail)
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				s.recordError(detail, err)
			}
			return
		}
	}
}

func (s *treeScan) recordError(detail *allocation, err error) {
	if s.root.err == nil {
		s.root.err = err
	}
	if detail != nil && detail.err == nil {
		detail.err = err
	}
}

func applyAllocation(item *model.Item, measured *allocation, fs string) {
	if measured.err != nil {
		addNote(item, fmt.Sprintf("Belegung konnte nicht ermittelt werden (%v).", measured.err))
		return
	}
	if !measured.seen {
		addNote(item, "Der Pfad war während der Messung nicht verfügbar.")
		return
	}
	item.Bytes = &measured.bytes
	item.Metric = "allocated_blocks"
	if measured.excluded {
		addNote(item, "Die Messung endet an untergeordneten Mounts.")
	}
	if fs == "btrfs" && item.ParentID == "" {
		addNote(item, "Belegte Dateiblöcke können gemeinsam genutzte Btrfs-Extents mehrfach enthalten.")
	}
	item.Additive = fs == "ext4" && item.ParentID == "" && !measured.excluded && len(measured.links) == 0
}

func openDirectory(p string) (*os.File, error) {
	fd, err := syscall.Open(p, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_DIRECTORY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: p, Err: err}
	}
	return os.NewFile(uintptr(fd), p), nil
}

func readDirectory(p string) ([]os.DirEntry, error) {
	dir, err := openDirectory(p)
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	entries, err := dir.ReadDir(-1)
	slices.SortFunc(entries, func(a, b os.DirEntry) int { return strings.Compare(a.Name(), b.Name()) })
	return entries, err
}
