//go:build !linux

package collector

import "synousage/internal/model"

func rootFilesystemInfo() *model.FilesystemInfo { return nil }
