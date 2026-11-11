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
	"syscall"
	"time"

	"synousage/internal/collector"
	"synousage/internal/model"
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

// Upgrade previously recorded root-owned runs to the package's read group.
func grantHistoryReadAccess(dir string, gid int) error {
	files, err := runFiles(dir)
	if err != nil {
		return err
	}
	for _, entry := range files {
		name := filepath.Join(dir, entry.Name())
		fd, err := syscall.Open(name, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		f := os.NewFile(uintptr(fd), name)
		info, err := f.Stat()
		if err == nil {
			stat, ok := info.Sys().(*syscall.Stat_t)
			if !ok || !info.Mode().IsRegular() || stat.Uid != 0 || stat.Nlink != 1 {
				err = fmt.Errorf("unsichere Messdatei: %s", name)
			}
		}
		if err == nil {
			err = f.Chown(0, gid)
		}
		if err == nil {
			err = f.Chmod(0640)
		}
		f.Close()
		if err != nil {
			return err
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
	group, err := user.LookupGroup("h5uSynoUsage")
	if err != nil {
		return fmt.Errorf("SynoUsage-Paketgruppe fehlt: %w", err)
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
	if err := lock.Chmod(0640); err != nil {
		return err
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		if errors.Is(err, syscall.EWOULDBLOCK) {
			fmt.Println("Eine SynoUsage-Erfassung läuft bereits.")
			return nil
		}
		return err
	}
	if err := grantHistoryReadAccess(runs, gid); err != nil {
		return fmt.Errorf("Leserechte der Messhistorie: %w", err)
	}
	for {
		restart, err := collectRun(ctx, dataDir, runs, gid, collector.Collect)
		if err != nil || !restart || ctx.Err() != nil {
			return err
		}
	}
}

func scanLogTimestamp(now, previous time.Time) string {
	clock := now.Format("15:04:05")
	if previous.IsZero() {
		return clock
	}
	minutes := strconv.FormatFloat(now.Sub(previous).Minutes(), 'f', 2, 64)
	minutes = strings.TrimSuffix(strings.TrimRight(minutes, "0"), ".")
	return clock + " +" + strings.Replace(minutes, ".", ",", 1) + " min"
}

func collectRun(ctx context.Context, dir, runs string, gid int,
	measure func(context.Context, func(string, string, int, int), func(model.Run)) (model.Run, error),
) (bool, error) {
	log, err := os.OpenFile(filepath.Join(dir, "collector.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0640)
	if err != nil {
		return false, err
	}
	defer log.Close()
	if err := log.Chown(0, gid); err != nil {
		return false, err
	}
	if err := log.Chmod(0640); err != nil {
		return false, err
	}
	var nonce [6]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return false, err
	}
	start := time.Now().UTC()
	id := start.Format(runStartLayout) + "-" + hex.EncodeToString(nonce[:])
	status := scanStatus{State: "running", RunID: id, Phase: "Vorbereitung", StartedAt: start.Format(time.RFC3339Nano)}
	logEscapes := strings.NewReplacer("\r", `\r`, "\n", `\n`)
	var lastLogAt time.Time
	logLine := func(message string) {
		now := time.Now()
		line := scanLogTimestamp(now, lastLogAt) + "  " + logEscapes.Replace(message)
		lastLogAt = now
		fmt.Fprintln(log, line)
		if len(status.Log) == 20 {
			status.Log = status.Log[1:]
		}
		status.Log = append(status.Log, line)
	}
	writeStatus := func() error {
		status.UpdatedAt = timestamp()
		return writeAtomicJSON(dir, "status.json", status, gid, 256<<10, false)
	}

	runContext, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	closeControl, controlErr := listenScanControl(runContext, dir, gid, id, cancel)
	defer func() {
		if closeControl != nil {
			closeControl()
		}
	}()
	status.CanCancel = controlErr == nil
	logLine("Erfassung gestartet")
	if controlErr != nil {
		logLine("Erfassung kann nicht über die App gesteuert werden · " + controlErr.Error())
	}
	if err := writeStatus(); err != nil {
		return false, err
	}
	if err := writeAtomicJSON(dir, "hardware.json", collector.HardwareInfo(), gid, 2<<20, true); err != nil {
		logLine("Hardwareinformationen konnten nicht gespeichert werden · " + err.Error())
	}

	var statusWriteErr, checkpointErr error
	updateStatus := func() {
		if err := writeStatus(); err != nil {
			statusWriteErr = err
		}
	}
	saveCurrent := func(run model.Run) {
		if err := writeAtomicJSON(dir, currentFile, run, gid, maxRunBytes, false); err != nil {
			checkpointErr = err
			return
		}
		status.Checkpoint = run.At.Format(time.RFC3339Nano)
	}

	lastUpdate := time.Now()
	run, err := measure(runContext, func(phase, current string, done, total int) {
		stepChanged := phase != status.Phase || current != status.Current
		status.Phase, status.Current, status.Done, status.Total = phase, current, done, total
		if stepChanged || time.Since(lastUpdate) >= time.Second || (total > 0 && done == total) {
			lastUpdate = time.Now()
			line := phase
			if current != "" {
				line += " · " + current
			}
			logLine(line)
			updateStatus()
		}
	}, func(run model.Run) {
		if len(run.Volumes) > 0 {
			run.ID, run.At, run.Partial = id, time.Now().UTC(), true
			saveCurrent(run)
			updateStatus()
		}
	})
	if closeControl != nil {
		closeControl()
		closeControl = nil
	}
	status.CanCancel = false

	cause := context.Cause(runContext)
	restart := errors.Is(cause, errScanRestarted)
	stopped := restart || errors.Is(cause, errScanCancelled) || errors.Is(cause, context.Canceled)
	if stopped {
		err = nil
	} else if err == nil {
		err = runContext.Err()
		if err == nil && len(run.Volumes) == 0 {
			err = errors.New("Keine Volumes gemessen")
		}
	}

	saved := false
	if err == nil && len(run.Volumes) > 0 {
		run.ID, run.At, run.Partial = id, time.Now().UTC(), stopped
		err = writeAtomicJSON(runs, id+".json", run, gid, maxRunBytes, true)
		saved = err == nil
	}
	switch {
	case err != nil:
		status.State, status.Message = "failed", err.Error()
		logLine("Erfassung fehlgeschlagen · " + err.Error())
	case stopped:
		status.State, status.Message = "cancelled", errScanCancelled.Error()
		if restart {
			status.Message = errScanRestarted.Error()
		}
		if saved {
			saveCurrent(run)
			status.Message += " · Teilergebnis gespeichert"
		}
	default:
		status.State = "complete"
		status.Message = fmt.Sprintf("%d Volumes erfasst", len(run.Volumes))
		if len(run.Warnings) == 1 {
			status.Message += " · 1 Hinweis"
		} else if len(run.Warnings) > 1 {
			status.Message += fmt.Sprintf(" · %d Hinweise", len(run.Warnings))
		}
		if removeErr := os.Remove(filepath.Join(dir, currentFile)); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			logLine("Zwischenstand konnte nicht aufgeräumt werden · " + removeErr.Error())
		}
		status.Checkpoint = ""
	}
	for _, warning := range run.Warnings {
		logLine("Hinweis · " + warning)
	}
	logLine(status.Message)
	if saved {
		if pruneErr := pruneHistory(runs); pruneErr != nil {
			logLine("Alte Messstände konnten nicht aufgeräumt werden · " + pruneErr.Error())
		}
	}
	if checkpointErr != nil {
		logLine("Zwischenstand konnte zeitweise nicht gespeichert werden · " + checkpointErr.Error())
	}
	if statusWriteErr != nil {
		logLine("Live-Status konnte zeitweise nicht gespeichert werden · " + statusWriteErr.Error())
	}
	status.Current = ""
	fmt.Println(status.Message)
	return restart, errors.Join(err, writeStatus())
}
