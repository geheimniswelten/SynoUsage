package model

import "time"

type HardwareInfo struct {
	At               string          `json:"at"`
	Model            string          `json:"model,omitempty"`
	DSM              string          `json:"dsm,omitempty"`
	Kernel           string          `json:"kernel,omitempty"`
	CPU              string          `json:"cpu,omitempty"`
	CPUs             int             `json:"cpus,omitempty"`
	MaxMHz           uint64          `json:"maxMHz,omitempty"`
	Memory           uint64          `json:"memory,omitempty"`
	Devices          []BlockDevice   `json:"devices"`
	LVM              []LVMVolume     `json:"lvm,omitempty"`
	PVs              []LVMPhysical   `json:"pvs,omitempty"`
	Root             *FilesystemInfo `json:"root,omitempty"`
	PartitionLayouts string          `json:"partitionLayouts,omitempty"`
	Warnings         []string        `json:"warnings,omitempty"`
}

type FilesystemInfo struct {
	Capacity uint64 `json:"capacity"`
	Used     uint64 `json:"used"`
	Free     uint64 `json:"free"`
}

type LVMPhysical struct {
	Name  string `json:"name"`
	Group string `json:"group"`
	Size  uint64 `json:"size"`
	Free  uint64 `json:"free"`
}
type LVMVolume struct {
	Name    string `json:"name"`
	Group   string `json:"group"`
	Size    uint64 `json:"size"`
	Devices string `json:"devices,omitempty"`
}

type BlockDevice struct {
	Name      string   `json:"name"`
	Kind      string   `json:"kind"`
	Model     string   `json:"model,omitempty"`
	Size      uint64   `json:"size"`
	Start     uint64   `json:"start,omitempty"`
	Parent    string   `json:"parent,omitempty"`
	Level     string   `json:"level,omitempty"`
	State     string   `json:"state,omitempty"`
	Members   []string `json:"members,omitempty"`
	Mounts    []string `json:"mounts,omitempty"`
	Label     string   `json:"label,omitempty"`
	Transport string   `json:"transport,omitempty"`
	Medium    string   `json:"medium,omitempty"`
}

type Run struct {
	Partial         bool      `json:"partial,omitempty"`
	ID              string    `json:"id"`
	At              time.Time `json:"at"`
	DurationSeconds *int64    `json:"durationSeconds,omitempty"`
	Volumes         []Volume  `json:"volumes"`
	Items           []Item    `json:"items"`
	Warnings        []string  `json:"warnings,omitempty"`
}

type Volume struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	FS       string `json:"fs"`
	Capacity uint64 `json:"capacity"`
	Used     uint64 `json:"used"`
	Free     uint64 `json:"free"`
}

type Item struct {
	ID                string  `json:"id"`
	VolumeID          string  `json:"volumeId"`
	Group             string  `json:"group"`
	Name              string  `json:"name"`
	Path              string  `json:"path"`
	Bytes             *uint64 `json:"bytes"`
	Metric            string  `json:"metric"`
	Note              string  `json:"note,omitempty"`
	ParentID          string  `json:"parentId,omitempty"`
	ExclusiveBytes    *uint64 `json:"exclusiveBytes,omitempty"`
	ReferencedBytes   *uint64 `json:"referencedBytes,omitempty"`
	SharedBytes       *uint64 `json:"sharedBytes,omitempty"`
	SnapshotCount     int     `json:"snapshotCount,omitempty"`
	SnapshotBytes     *uint64 `json:"snapshotBytes,omitempty"`
	SnapshotMetric    string  `json:"snapshotMetric,omitempty"`
	MeasuredSnapshots int     `json:"measuredSnapshots,omitempty"`
	Additive          bool    `json:"additive"`
}
