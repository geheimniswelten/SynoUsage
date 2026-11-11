package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"synousage/internal/model"
)

const (
	maxRuns         = 120
	maxHistoryBytes = 24 << 20
	maxRunBytes     = 8 << 20
	currentFile     = "current.json"
	runStartLayout  = "20060102T150405.000000000"
)

var runFilename = regexp.MustCompile(`^\d{8}T\d{6}\.\d{9}-[a-f0-9]{12}\.json$`)

type scanStatus struct {
	Checkpoint string   `json:"checkpoint,omitempty"`
	CanCancel  bool     `json:"canCancel,omitempty"`
	State      string   `json:"state"`
	RunID      string   `json:"runId,omitempty"`
	Phase      string   `json:"phase,omitempty"`
	Current    string   `json:"current,omitempty"`
	Done       int      `json:"done"`
	Total      int      `json:"total"`
	StartedAt  string   `json:"startedAt,omitempty"`
	UpdatedAt  string   `json:"updatedAt,omitempty"`
	Message    string   `json:"message,omitempty"`
	Log        []string `json:"log,omitempty"`
}

func readStatus(dir string) (scanStatus, error) {
	var status scanStatus
	err := readJSON(filepath.Join(dir, "status.json"), 256<<10, &status)
	if errors.Is(err, os.ErrNotExist) {
		return scanStatus{State: "idle"}, nil
	}
	if err != nil {
		return status, err
	}
	if status.State == "running" && runLockReleased(dir) {
		// A scan may have begun just after the lock probe. Only describe the
		// previous run as interrupted if its saved status still matches.
		var latest scanStatus
		if err := readJSON(filepath.Join(dir, "status.json"), 256<<10, &latest); err == nil {
			if latest.State == "running" && latest.RunID == status.RunID && latest.UpdatedAt == status.UpdatedAt {
				latest.State = "failed"
				latest.CanCancel = false
				latest.Message = "Die letzte Erfassung wurde unterbrochen."
			}
			return latest, nil
		}
	}
	return status, nil
}

func readJSON(path string, limit int64, value any) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return err
	}
	if int64(len(data)) > limit {
		return fmt.Errorf("Messdatei zu groß: %s", filepath.Base(path))
	}
	return json.Unmarshal(data, value)
}

func readRun(path string) (model.Run, error) {
	var run model.Run
	if err := readJSON(path, maxRunBytes, &run); err != nil {
		return run, err
	}
	// The run ID records the UTC start time, including in older measurements.
	stamp, _, _ := strings.Cut(run.ID, "-")
	if start, err := time.Parse(runStartLayout, stamp); err == nil && !run.At.Before(start) {
		seconds := int64(run.At.Sub(start) / time.Second)
		run.DurationSeconds = &seconds
	}
	return run, nil
}

func runFiles(dir string) ([]os.DirEntry, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	files := make([]os.DirEntry, 0, len(entries))
	for i := len(entries) - 1; i >= 0; i-- {
		entry := entries[i]
		if entry.Type().IsRegular() && runFilename.MatchString(entry.Name()) {
			files = append(files, entry)
		}
	}
	return files, nil
}

func readRuns(dir string) ([]model.Run, error) {
	runs := make([]model.Run, 0)
	root := filepath.Join(dir, "runs")
	files, err := runFiles(root)
	if errors.Is(err, os.ErrNotExist) {
		return runs, nil
	}
	if err != nil {
		return nil, err
	}
	var total int64
	for _, file := range files {
		info, err := file.Info()
		if errors.Is(err, os.ErrNotExist) {
			continue // The collector may have just removed an old measurement.
		}
		if err != nil {
			return nil, err
		}
		if len(runs) >= maxRuns || total+info.Size() > maxHistoryBytes {
			break
		}
		run, err := readRun(filepath.Join(root, file.Name()))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("%s: %w", file.Name(), err)
		}
		runs = append(runs, run)
		total += info.Size()
	}
	sort.SliceStable(runs, func(i, j int) bool { return runs[i].At.Before(runs[j].At) })
	return runs, nil
}

func timestamp() string { return time.Now().UTC().Format(time.RFC3339Nano) }
