//go:build linux

package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"synousage/internal/collector"
	"syscall"
	"time"
)

func ensureRootDir(path string, gid int) error {
	if err := os.Mkdir(path, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Sys().(*syscall.Stat_t).Uid != 0 || info.Mode().Perm()&0022 != 0 {
		return fmt.Errorf("unsicheres Datenverzeichnis: %s", path)
	}
	if err := os.Chown(path, 0, gid); err != nil {
		return err
	}
	return os.Chmod(path, 0750)
}

func runLockReleased(dir string) bool {
	file, err := os.Open(filepath.Join(dir, "scan.lock"))
	if err != nil {
		return errors.Is(err, os.ErrNotExist)
	}
	defer file.Close()
	return syscall.Flock(int(file.Fd()), syscall.LOCK_SH|syscall.LOCK_NB) == nil
}

func writeAtomicJSON(dir, name string, value any, gid int, limit int, durable bool) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(data) > limit {
		return fmt.Errorf("Messdatei zu groß: %s", name)
	}
	file, err := os.CreateTemp(dir, ".writing-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if err := file.Chown(0, gid); err != nil {
		return err
	}
	if err := file.Chmod(0640); err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		return err
	}
	if durable {
		if err := file.Sync(); err != nil {
			return err
		}
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(file.Name(), filepath.Join(dir, name)); err != nil || !durable {
		return err
	}
	parent, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer parent.Close()
	return parent.Sync()
}

func pruneHistory(dir string) error {
	files, err := runFiles(dir)
	if err != nil {
		return err
	}
	var size int64
	for index, entry := range files {
		info, err := entry.Info()
		if err != nil {
			return err
		}
		size += info.Size()
		if index >= maxRuns || size > maxHistoryBytes {
			if err := os.Remove(filepath.Join(dir, entry.Name())); err != nil {
				return err
			}
		}
	}
	return nil
}

func collectOnDSM(ctx context.Context) error {
	if os.Geteuid() != 0 {
		return errors.New("Erfassung als root im DSM-Aufgabenplaner ausführen")
	}
	if _, err := os.Stat(enabledFile); err != nil {
		return errors.New("SynoUsage im Paket-Zentrum starten")
	}
	group, err := user.LookupGroup("http")
	if err != nil {
		return fmt.Errorf("DSM-Webgruppe http fehlt: %w", err)
	}
	gid, err := strconv.Atoi(group.Gid)
	if err != nil {
		return err
	}
	runs := filepath.Join(dataDir, "runs")
	for _, dir := range []string{dataDir, runs} {
		if err := ensureRootDir(dir, gid); err != nil {
			return err
		}
	}
	lock, err := os.OpenFile(filepath.Join(dataDir, "scan.lock"), os.O_CREATE|os.O_RDWR, 0640)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := lock.Chown(0, gid); err != nil {
		return err
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		if errors.Is(err, syscall.EWOULDBLOCK) {
			fmt.Println("Eine SynoUsage-Erfassung läuft bereits.")
			return nil
		}
		return err
	}
	log, err := os.OpenFile(filepath.Join(dataDir, "collector.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0640)
	if err != nil {
		return err
	}
	defer log.Close()
	if err := log.Chown(0, gid); err != nil {
		return err
	}
	var nonce [6]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return err
	}
	start := time.Now().UTC()
	id := start.Format("20060102T150405.000000000") + "-" + hex.EncodeToString(nonce[:])
	status := scanStatus{State: "running", RunID: id, Phase: "Vorbereitung", StartedAt: start.Format(time.RFC3339Nano)}
	logLine := func(message string) {
		line := time.Now().Format("15:04:05") + "  " + strings.NewReplacer("\r", `\r`, "\n", `\n`).Replace(message)
		fmt.Fprintln(log, line)
		if len(status.Log) == 20 {
			status.Log = status.Log[1:]
		}
		status.Log = append(status.Log, line)
	}
	writeStatus := func() error {
		status.UpdatedAt = timestamp()
		return writeAtomicJSON(dataDir, "status.json", status, gid, 256<<10, false)
	}
	logLine("Erfassung gestartet")
	if err := writeStatus(); err != nil {
		return err
	}
	var statusWriteErr error
	lastUpdate := time.Now()
	run, err := collector.Collect(ctx, func(phase, current string, done, total int) {
		phaseChanged := phase != status.Phase
		status.Phase, status.Current, status.Done, status.Total = phase, current, done, total
		if phaseChanged || time.Since(lastUpdate) >= time.Second || (total > 0 && done == total) {
			lastUpdate = time.Now()
			line := phase
			if current != "" {
				line += " · " + current
			}
			logLine(line)
			if writeErr := writeStatus(); writeErr != nil {
				statusWriteErr = writeErr
			}
		}
	})
	if err == nil {
		err = ctx.Err()
	}
	if err == nil && len(run.Volumes) == 0 {
		err = errors.New("Keine Volumes gemessen")
	}
	if err == nil {
		run.ID = id
		run.At = time.Now().UTC()
		err = writeAtomicJSON(runs, id+".json", run, gid, maxRunBytes, true)
	}
	if err != nil {
		status.State, status.Message = "failed", err.Error()
		logLine("Erfassung fehlgeschlagen · " + err.Error())
	} else {
		status.State = "complete"
		status.Message = fmt.Sprintf("%d Volumes erfasst", len(run.Volumes))
		if len(run.Warnings) > 0 {
			status.Message += fmt.Sprintf(" · %d Hinweise", len(run.Warnings))
		}
		logLine(status.Message)
		if pruneErr := pruneHistory(runs); pruneErr != nil {
			logLine("Alte Messstände konnten nicht aufgeräumt werden · " + pruneErr.Error())
		}
	}
	if statusWriteErr != nil {
		logLine("Live-Status konnte zeitweise nicht gespeichert werden · " + statusWriteErr.Error())
	}
	status.Current = ""
	fmt.Println(status.Message)
	return errors.Join(err, writeStatus())
}
