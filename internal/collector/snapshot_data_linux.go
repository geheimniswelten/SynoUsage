package collector

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"slices"
)

// Bound the collector's memory on smaller NAS models. Larger sets are
// measured in disjoint address ranges.
const snapshotExtentsPerPass = 2_000_000

type btrfsRoot struct {
	generation uint64
	bytenr     uint64
	flags      uint64
}

func (r *btrfsTreeReader) activeRoots(ctx context.Context) (map[uint64]btrfsRoot, error) {
	roots := make(map[uint64]btrfsRoot)
	// Root IDs with a nonzero qgroup level are not filesystem trees.
	first := btrfsKey{object: btrfsFSTree, kind: btrfsRootItem}
	last := btrfsKey{object: 1<<48 - 1, kind: btrfsRootItem, offset: math.MaxUint64}
	err := r.walk(ctx, btrfsRootTree, first, last, func(key btrfsKey, item []byte) error {
		if key.kind != btrfsRootItem || (key.object != btrfsFSTree && key.object < 256) {
			return nil
		}
		if len(item) < 220 {
			return errors.New("Unvollständiger Btrfs-Root-Eintrag")
		}
		// refs=0 denotes a root already removed from the filesystem namespace.
		if binary.LittleEndian.Uint32(item[216:220]) != 0 {
			roots[key.object] = btrfsRoot{
				generation: binary.LittleEndian.Uint64(item[160:168]),
				bytenr:     binary.LittleEndian.Uint64(item[176:184]),
				flags:      binary.LittleEndian.Uint64(item[208:216]),
			}
		}
		return nil
	})
	if err == nil && len(roots) == 0 {
		err = errors.New("Keine aktiven Btrfs-Dateisystembäume gefunden")
	}
	return roots, err
}

func (r *btrfsTreeReader) fileExtents(ctx context.Context, root uint64, visit func(bytenr, size uint64) error) error {
	first := btrfsKey{object: 256, kind: btrfsFileExtentItem}
	last := btrfsKey{object: math.MaxUint64 - 255, kind: btrfsFileExtentItem, offset: math.MaxUint64}
	return r.walk(ctx, root, first, last, func(key btrfsKey, item []byte) error {
		if key.kind != btrfsFileExtentItem {
			return nil
		}
		if r.legacy && len(item) == 0 {
			// V1 can omit oversized payloads. A non-inline extent item fits.
			return nil
		}
		if len(item) < 21 {
			return errors.New("Unvollständiger Btrfs-Dateiextent")
		}
		switch item[20] {
		case 0: // inline data is part of the metadata leaf
			return nil
		case 1, 2: // regular or preallocated, including beyond EOF
			if len(item) < 53 {
				return errors.New("Unvollständiger Btrfs-Datenextent")
			}
			bytenr := binary.LittleEndian.Uint64(item[21:29])
			if bytenr == 0 { // hole
				return nil
			}
			size := binary.LittleEndian.Uint64(item[29:37])
			if size == 0 {
				return errors.New("Ungültige Btrfs-Extentgröße")
			}
			return visit(bytenr, size)
		default:
			return errors.New("Unbekannter Btrfs-Extenttyp")
		}
	})
}

type snapshotExtent struct {
	size     uint64
	lastRoot uint64
	oneRoot  uint64
	// A negative source means the extent is shared across multiple sources.
	source int
}

type snapshotData struct {
	total, shared uint64
	bySource      map[string]uint64
	exclusive     map[uint64]uint64
	referenced    map[uint64]uint64
}

var errNoSnapshotExtents = errors.New("keine Kandidaten übrig")
var errSplitExtentRange = errors.New("Extent-Bereich aufteilen")

type extentRange struct{ first, last uint64 }

func snapshotExtents(ctx context.Context, reader *btrfsTreeReader, candidates []uint64, sources map[uint64]int, address extentRange, limit int) (map[uint64]snapshotExtent, map[uint64]uint64, uint64, error) {
	extents := make(map[uint64]snapshotExtent)
	referenced := make(map[uint64]uint64)
	low, high := uint64(math.MaxUint64), uint64(0)
	for _, id := range candidates {
		index := sources[id]
		err := reader.fileExtents(ctx, id, func(bytenr, size uint64) error {
			if bytenr < address.first || bytenr > address.last {
				return nil
			}
			extent, seen := extents[bytenr]
			if !seen {
				low, high = min(low, bytenr), max(high, bytenr)
				if len(extents) >= limit {
					return errSplitExtentRange
				}
				extent = snapshotExtent{size: size, oneRoot: id, source: index}
			} else if size != extent.size {
				return errors.New("Die Größe eines Btrfs-Extents hat sich während der Messung geändert")
			}
			if extent.lastRoot != id {
				referenced[id] += size
				extent.lastRoot = id
			}
			if extent.oneRoot != id {
				extent.oneRoot = 0
			}
			if extent.source != index {
				extent.source = -1
			}
			extents[bytenr] = extent
			return nil
		})
		if errors.Is(err, errSplitExtentRange) {
			return nil, nil, low + (high-low)/2, nil
		}
		if err != nil {
			return nil, nil, 0, err
		}
	}
	return extents, referenced, 0, nil
}

func excludeLiveExtents(ctx context.Context, reader *btrfsTreeReader, roots []uint64, extents map[uint64]snapshotExtent) error {
	for _, id := range roots {
		if len(extents) == 0 {
			return nil
		}
		err := reader.fileExtents(ctx, id, func(bytenr, _ uint64) error {
			delete(extents, bytenr)
			if len(extents) == 0 {
				return errNoSnapshotExtents
			}
			return nil
		})
		if errors.Is(err, errNoSnapshotExtents) {
			return nil
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// An allocated extent remains occupied as a whole while any file tree still
// references it. The allocation key and on-disk size also handle compression
// and reflinks of only a portion of an extent.
func measureSnapshotData(ctx context.Context, reader *btrfsTreeReader, roots map[uint64]btrfsRoot, snapshotSources map[uint64]string, limit int) (snapshotData, error) {
	data := snapshotData{
		bySource: make(map[string]uint64), exclusive: make(map[uint64]uint64), referenced: make(map[uint64]uint64),
	}
	sourceIndex := make(map[string]int)
	var sources []string
	var candidates, live []uint64
	bySnapshot := make(map[uint64]int, len(snapshotSources))
	for id, source := range snapshotSources {
		if _, ok := roots[id]; !ok {
			return snapshotData{}, fmt.Errorf("Snapshot-Baum %d ist nicht mehr verfügbar", id)
		}
		index, found := sourceIndex[source]
		if !found {
			index = len(sources)
			sources = append(sources, source)
			sourceIndex[source] = index
		}
		bySnapshot[id] = index
		candidates = append(candidates, id)
	}
	for id := range roots {
		if _, candidate := snapshotSources[id]; !candidate {
			live = append(live, id)
		}
	}
	slices.Sort(candidates)
	slices.Sort(live)
	pending := []extentRange{{last: math.MaxUint64}}
	for len(pending) > 0 {
		address := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		extents, referenced, split, err := snapshotExtents(ctx, reader, candidates, bySnapshot, address, limit)
		if err != nil {
			return snapshotData{}, err
		}
		if split != 0 {
			pending = append(pending, extentRange{first: split + 1, last: address.last}, extentRange{first: address.first, last: split})
			continue
		}
		if err := excludeLiveExtents(ctx, reader, live, extents); err != nil {
			return snapshotData{}, err
		}
		for id, size := range referenced {
			data.referenced[id] += size
		}
		for _, extent := range extents {
			data.total += extent.size
			if extent.source < 0 {
				data.shared += extent.size
			} else {
				data.bySource[sources[extent.source]] += extent.size
			}
			if extent.oneRoot != 0 {
				data.exclusive[extent.oneRoot] += extent.size
			}
		}
	}
	current, err := reader.activeRoots(ctx)
	if err != nil {
		return snapshotData{}, err
	}
	if len(current) != len(roots) {
		return snapshotData{}, errors.New("Die Btrfs-Subvolumes haben sich während der Messung geändert")
	}
	for id, root := range roots {
		_, candidate := snapshotSources[id]
		if now, exists := current[id]; !exists || (candidate && now != root) {
			return snapshotData{}, errors.New("Die Btrfs-Subvolumes haben sich während der Messung geändert")
		}
	}
	if err := ctx.Err(); err != nil {
		return snapshotData{}, err
	}
	return data, nil
}
