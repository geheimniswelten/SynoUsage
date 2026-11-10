package model

import "time"

type Run struct {
	ID       string    `json:"id"`
	At       time.Time `json:"at"`
	Volumes  []Volume  `json:"volumes"`
	Items    []Item    `json:"items"`
	Warnings []string  `json:"warnings,omitempty"`
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
	MeasuredSnapshots int     `json:"measuredSnapshots,omitempty"`
	Additive          bool    `json:"additive"`
}
