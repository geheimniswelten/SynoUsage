package collector

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"os"
	"syscall"
	"unsafe"
)

const (
	btrfsRootTree         = 1
	btrfsFSTree           = 5
	btrfsRootItem         = 132
	btrfsFileExtentItem   = 108
	btrfsRootReadOnly     = 1
	btrfsSearchBufferSize = 256 * 1024

	// Linux UAPI btrfs_ioctl_search_args(_v2) on DSM's x86_64 kernel.
	btrfsTreeSearchV1         = 0xd0009411
	btrfsTreeSearchV2         = 0xc0709411
	btrfsSearchKeySize        = 104
	btrfsSearchV2HeaderSize   = btrfsSearchKeySize + 8
	btrfsSearchItemHeaderSize = 32
)

type btrfsKey struct {
	object uint64
	kind   uint32
	offset uint64
}

func (k btrfsKey) before(other btrfsKey) bool {
	if k.object != other.object {
		return k.object < other.object
	}
	if k.kind != other.kind {
		return k.kind < other.kind
	}
	return k.offset < other.offset
}

func (k btrfsKey) next() btrfsKey {
	if k.offset < math.MaxUint64 {
		k.offset++
		return k
	}
	if k.kind < math.MaxUint8 {
		return btrfsKey{object: k.object, kind: k.kind + 1}
	}
	return btrfsKey{object: k.object + 1}
}

type btrfsTreeReader struct {
	file   *os.File
	buf    []byte
	legacy bool
}

func (r *btrfsTreeReader) search(tree uint64, first, last btrfsKey) ([]byte, uint32, error) {
	request := uintptr(btrfsTreeSearchV2)
	start, end := btrfsSearchV2HeaderSize, len(r.buf)
	if r.legacy {
		request = btrfsTreeSearchV1
		start, end = btrfsSearchKeySize, 4096
	}
	buf := r.buf[:end]
	key := buf[:btrfsSearchKeySize]
	clear(key)
	order := binary.NativeEndian
	order.PutUint64(key[0:8], tree)
	order.PutUint64(key[8:16], first.object)
	order.PutUint64(key[16:24], last.object)
	order.PutUint64(key[24:32], first.offset)
	order.PutUint64(key[32:40], last.offset)
	order.PutUint64(key[48:56], math.MaxUint64) // max_transid
	order.PutUint32(key[56:60], first.kind)
	order.PutUint32(key[60:64], last.kind)
	order.PutUint32(key[64:68], uint32((end-start)/btrfsSearchItemHeaderSize))
	if !r.legacy {
		order.PutUint64(buf[btrfsSearchKeySize:start], uint64(end-start))
	}
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, r.file.Fd(), request, uintptr(unsafe.Pointer(&buf[0])))
	if errno != 0 {
		if !r.legacy && (errno == syscall.ENOTTY || errno == syscall.EOPNOTSUPP) {
			r.legacy = true
			return r.search(tree, first, last)
		}
		return nil, 0, errno
	}
	return buf[start:], order.Uint32(key[64:68]), nil
}

func (r *btrfsTreeReader) walk(ctx context.Context, tree uint64, first, last btrfsKey, visit func(btrfsKey, []byte) error) error {
	for !last.before(first) {
		if err := ctx.Err(); err != nil {
			return err
		}
		page, count, err := r.search(tree, first, last)
		if errors.Is(err, syscall.EINTR) {
			continue
		}
		if err != nil {
			return fmt.Errorf("Btrfs-Baum %d: %w", tree, err)
		}
		if count == 0 {
			return nil
		}
		for i := uint32(0); i < count; i++ {
			if len(page) < btrfsSearchItemHeaderSize {
				return errors.New("Unvollständiger Btrfs-Suchheader")
			}
			order := binary.NativeEndian
			key := btrfsKey{object: order.Uint64(page[8:16]), kind: order.Uint32(page[24:28]), offset: order.Uint64(page[16:24])}
			size := order.Uint32(page[28:32])
			page = page[btrfsSearchItemHeaderSize:]
			if key.before(first) || last.before(key) || key.kind > math.MaxUint8 || uint64(size) > uint64(len(page)) {
				return errors.New("Ungültiges Ergebnis der Btrfs-Baumsuche")
			}
			if err := visit(key, page[:size]); err != nil {
				return err
			}
			if key == last {
				return nil
			}
			first = key.next()
			page = page[size:]
		}
	}
	return nil
}
