package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"time"
)

const scanControlSocket = "scan.sock"
const scanControlTimeout = 3 * time.Second

var (
	errScanCancelled = errors.New("Erfassung abgebrochen")
	errScanRestarted = errors.New("Erfassung für Neustart beendet")
	errScanNotActive = errors.New("Die Erfassung ist bereits beendet oder wird gerade beendet.")
)

func listenScanControl(ctx context.Context, dir string, gid int, id string, cancel context.CancelCauseFunc) (func(), error) {
	path := filepath.Join(dir, scanControlSocket)
	// Only the collector that holds the exclusive scan lock can replace a stale socket.
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return nil, errors.New("Der Steuerpfad ist kein Socket")
		}
		if err := os.Remove(path); err != nil {
			return nil, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		return nil, err
	}
	if err := os.Chown(path, -1, gid); err != nil {
		listener.Close()
		return nil, err
	}
	if err := os.Chmod(path, 0660); err != nil {
		listener.Close()
		return nil, err
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			conn, err := listener.AcceptUnix()
			if err != nil {
				return
			}
			handleScanControl(ctx, conn, id, cancel)
		}
	}()
	return func() {
		listener.Close()
		<-done
	}, nil
}

func handleScanControl(ctx context.Context, conn net.Conn, id string, cancel context.CancelCauseFunc) {
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(scanControlTimeout)); err != nil {
		return
	}
	line, err := bufio.NewReaderSize(conn, 128).ReadSlice('\n')
	if err != nil || ctx.Err() != nil {
		return
	}
	switch string(line) {
	case id + " cancel\n":
		cancel(errScanCancelled)
	case id + " restart\n":
		cancel(errScanRestarted)
	default:
		return
	}
	_, _ = io.WriteString(conn, "ok\n")
}

func requestScanControl(ctx context.Context, dir, id, action string) error {
	ctx, cancel := context.WithTimeout(ctx, scanControlTimeout)
	defer cancel()
	conn, err := (&net.Dialer{}).DialContext(ctx, "unix", filepath.Join(dir, scanControlSocket))
	if err != nil {
		return errScanNotActive
	}
	defer conn.Close()
	deadline, _ := ctx.Deadline()
	if err := conn.SetDeadline(deadline); err != nil {
		return err
	}
	if _, err := fmt.Fprintf(conn, "%s %s\n", id, action); err != nil {
		return errScanNotActive
	}
	reply, err := bufio.NewReaderSize(conn, 32).ReadSlice('\n')
	if err != nil || string(reply) != "ok\n" {
		return errScanNotActive
	}
	return nil
}
