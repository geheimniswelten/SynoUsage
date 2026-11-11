package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"synousage/internal/model"
)

func TestScanControl(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("collector persistence uses root-owned files")
	}
	dir := t.TempDir()
	runs := filepath.Join(dir, "runs")
	if err := os.Mkdir(runs, 0700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(dir, "enabled")
	if err := os.WriteFile(marker, nil, 0600); err != nil {
		t.Fatal(err)
	}
	lock, err := os.Create(filepath.Join(dir, "scan.lock"))
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	handler := stateHandler(dir, marker, func(r *http.Request) (string, error) {
		if r.Header.Get("X-Syno-Token") != "fixture-session" {
			return "", errNotAdmin
		}
		return "fixture-admin", nil
	})
	get := func(query string) responseState {
		t.Helper()
		r := httptest.NewRequest(http.MethodGet, "/api.cgi"+query, nil)
		r.Header.Set("X-Syno-Token", "fixture-session")
		reply := httptest.NewRecorder()
		handler.ServeHTTP(reply, r)
		var state responseState
		if reply.Code != http.StatusOK || json.Unmarshal(reply.Body.Bytes(), &state) != nil {
			t.Fatalf("GET %s: %d %s", query, reply.Code, reply.Body)
		}
		return state
	}
	post := func(action, id, token, site string, want int) {
		t.Helper()
		r := httptest.NewRequest(http.MethodPost, "/api.cgi?action="+action, strings.NewReader("{\"runId\":\""+id+"\"}"))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Syno-Token", token)
		r.Header.Set("Sec-Fetch-Site", site)
		reply := httptest.NewRecorder()
		handler.ServeHTTP(reply, r)
		if reply.Code != want {
			t.Fatalf("POST %s: %d, want %d; %s", action, reply.Code, want, reply.Body)
		}
	}

	var previousID string
	for _, action := range []string{"restart", "cancel"} {
		func() {
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan struct{})
			defer func() {
				cancel()
				<-done
			}()
			started := make(chan struct{})
			var restart bool
			var runErr error
			bytes := uint64(4 << 30)
			go func() {
				defer close(done)
				restart, runErr = collectRun(ctx, dir, runs, os.Getgid(),
					func(ctx context.Context, progress func(string, string, int, int), checkpoint func(model.Run)) (model.Run, error) {
						run := model.Run{
							Volumes: []model.Volume{{ID: "volume1"}},
							Items:   []model.Item{{ID: "measured", VolumeID: "volume1", Bytes: &bytes}},
						}
						progress("scan", "/volume1/Drive", 0, 2)
						progress("scan", "/volume1/ABB", 1, 2)
						checkpoint(run)
						close(started)
						<-ctx.Done()
						return run, ctx.Err()
					},
				)
			}()
			select {
			case <-started:
			case <-done:
				t.Fatalf("collector stopped before the first checkpoint: %v", runErr)
			case <-time.After(10 * time.Second):
				t.Fatal("collector did not publish its checkpoint")
			}

			live := get("?view=current")
			id := live.Status.RunID
			if id == "" || id == previousID || live.Status.State != "running" || !live.Status.CanCancel || live.Status.Checkpoint == "" ||
				live.Current == nil || !live.Current.Partial || live.Current.ID != id || live.Runs != nil ||
				len(live.Current.Items) != 1 || live.Current.Items[0].Bytes == nil || *live.Current.Items[0].Bytes != bytes {
				t.Fatalf("invalid live result: %+v / %+v", live.Status, live.Current)
			}
			if get("?view=status").Current != nil {
				t.Fatal("status request returned the live measurement")
			}
			log := live.Status.Log
			if len(log) < 3 || !strings.HasSuffix(log[len(log)-2], " min  scan · /volume1/Drive") ||
				!strings.HasSuffix(log[len(log)-1], " min  scan · /volume1/ABB") {
				t.Fatalf("expected both scan steps with elapsed time: %v", log)
			}

			stale := "20261111T012345.123456789-000000000000"
			if previousID != "" {
				stale = previousID
			}
			post(action, id, "", "same-origin", http.StatusForbidden)
			post(action, id, "fixture-session", "cross-site", http.StatusForbidden)
			post(action, stale, "fixture-session", "same-origin", http.StatusConflict)
			post(action, id, "fixture-session", "same-origin", http.StatusAccepted)
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("collector did not respond to the request")
			}
			if runErr != nil || restart != (action == "restart") {
				t.Fatalf("%s: restart=%v, err=%v", action, restart, runErr)
			}
			result := get("")
			if result.Status.State != "cancelled" || result.Status.CanCancel || result.Current == nil ||
				!result.Current.Partial || result.Current.ID != id || result.Runs == nil {
				t.Fatalf("invalid aborted result: %+v / %+v", result.Status, result.Current)
			}
			var persisted model.Run
			if err := readJSON(filepath.Join(runs, id+".json"), maxRunBytes, &persisted); err != nil ||
				!persisted.Partial || len(persisted.Items) != 1 || persisted.Items[0].Bytes == nil || *persisted.Items[0].Bytes != bytes {
				t.Fatalf("aborted run was not preserved: %+v, err=%v", persisted, err)
			}
			if _, err := os.Lstat(filepath.Join(dir, scanControlSocket)); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("control socket not cleaned up: %v", err)
			}
			previousID = id
		}()
	}
	final := get("")
	if final.Runs == nil || len(*final.Runs) != 2 {
		t.Fatal("restart discarded the previous partial result")
	}
}

func TestScanLogTimestamp(t *testing.T) {
	start := time.Date(2026, time.November, 11, 23, 55, 0, 0, time.UTC)
	if got := scanLogTimestamp(start, time.Time{}); got != "23:55:00" {
		t.Fatalf("first timestamp: %q", got)
	}
	if got := scanLogTimestamp(start.Add(21*time.Second), start); got != "23:55:21 +0,35 min" {
		t.Fatalf("short interval: %q", got)
	}
	if got := scanLogTimestamp(start.Add(15*time.Minute+2*time.Second), start); got != "00:10:02 +15,03 min" {
		t.Fatalf("interval across midnight: %q", got)
	}
}
