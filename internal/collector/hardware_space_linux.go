//go:build linux

package collector

import (
	"synousage/internal/model"
	"syscall"
)

func rootFilesystemInfo() *model.FilesystemInfo {
	var s syscall.Statfs_t
	if syscall.Statfs("/", &s) != nil {
		return nil
	}
	block := uint64(s.Frsize)
	if block == 0 {
		block = uint64(s.Bsize)
	}
	if block == 0 || s.Bfree > s.Blocks || s.Bavail > s.Bfree {
		return nil
	}
	return &model.FilesystemInfo{Capacity: s.Blocks * block, Used: (s.Blocks - s.Bfree) * block, Free: s.Bavail * block}
}
