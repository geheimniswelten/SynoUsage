package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"time"

	"synousage/internal/collector"
	"synousage/internal/model"
)

var errNotAdmin = errors.New("SynoUsage ist auf DSM-Administratoren beschränkt")

func authenticateDSM(r *http.Request) (string, error) {
	if r.Header.Get("Cookie") == "" {
		return "", errors.New("DSM-Anmeldung fehlt")
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	// The helper reads the original, server-supplied CGI environment.
	command := exec.CommandContext(ctx, "/usr/syno/synoman/webman/modules/authenticate.cgi")
	if token := r.Header.Get("X-Syno-Token"); token != "" && len(token) <= 1024 {
		// The helper may read the token from the query string on older DSM builds.
		// Only the child environment is changed; the browser URL stays token-free.
		for _, entry := range os.Environ() {
			key, _, _ := strings.Cut(entry, "=")
			switch key {
			case "QUERY_STRING", "REQUEST_METHOD", "CONTENT_LENGTH", "CONTENT_TYPE":
				continue
			}
			command.Env = append(command.Env, entry)
		}
		// Authentication uses the cookie and token without forwarding the control request body.
		command.Env = append(command.Env, "REQUEST_METHOD=GET",
			"QUERY_STRING="+url.Values{"SynoToken": {token}}.Encode())
	}
	output, err := command.Output()
	if err != nil {
		return "", errors.New("DSM-Anmeldung konnte nicht geprüft werden")
	}
	name := strings.TrimSpace(string(output))
	if name == "" || len(name) > 256 || strings.ContainsAny(name, "\r\n\x00") {
		return "", errors.New("DSM-Anmeldung fehlt oder ist abgelaufen")
	}
	account, err := user.Lookup(name)
	if err != nil {
		return "", errNotAdmin
	}
	admins, err := user.LookupGroup("administrators")
	if err != nil {
		return "", errNotAdmin
	}
	if account.Gid == admins.Gid {
		return name, nil
	}
	groups, err := account.GroupIds()
	if err == nil {
		for _, group := range groups {
			if group == admins.Gid {
				return name, nil
			}
		}
	}
	return "", errNotAdmin
}

type responseState struct {
	Current  *model.Run          `json:"current,omitempty"`
	Runs     *[]model.Run        `json:"runs,omitempty"`
	Status   scanStatus          `json:"status"`
	User     string              `json:"user"`
	Hardware *model.HardwareInfo `json:"hardware,omitempty"`
}

type taskClock struct {
	Now       int64  `json:"now"`
	TimeZone  string `json:"timeZone,omitempty"`
	UTCOffset int    `json:"utcOffset"`
}

func readTaskClock() taskClock {
	now := time.Now()
	_, offset := now.Zone()
	result := taskClock{Now: now.Unix(), UTCOffset: offset}
	if localtime, err := filepath.EvalSymlinks("/etc/localtime"); err == nil {
		if _, zone, ok := strings.Cut(filepath.ToSlash(localtime), "/zoneinfo/"); ok {
			result.TimeZone = zone
		}
	}
	return result
}

func stateHandler(dir, marker string, authenticate func(*http.Request) (string, error)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		fail := func(code int, message string) {
			w.WriteHeader(code)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
		}
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			w.Header().Set("Allow", "GET, POST")
			fail(http.StatusMethodNotAllowed, "Ungültige Anfragemethode")
			return
		}
		if r.Method == http.MethodPost {
			token := strings.TrimSpace(r.Header.Get("X-Syno-Token"))
			site := r.Header.Get("Sec-Fetch-Site")
			if token == "" || len(token) > 1024 || (site != "" && site != "same-origin") {
				fail(http.StatusForbidden, "Abbruch oder Neustart aus der DSM-App anfordern")
				return
			}
		}
		name, err := authenticate(r)
		if err != nil {
			code := http.StatusUnauthorized
			if errors.Is(err, errNotAdmin) {
				code = http.StatusForbidden
			}
			fail(code, err.Error())
			return
		}
		if _, err := os.Stat(marker); err != nil {
			fail(http.StatusConflict, "SynoUsage im Paket-Zentrum starten")
			return
		}
		view := r.URL.Query().Get("view")
		if r.Method == http.MethodGet && view == "task-clock" {
			_ = json.NewEncoder(w).Encode(readTaskClock())
			return
		}
		status, err := readStatus(dir)
		if err != nil {
			fmt.Fprintln(os.Stderr, "SynoUsage status:", err)
			fail(http.StatusInternalServerError, "Der Erfassungsstatus konnte nicht gelesen werden")
			return
		}
		if r.Method == http.MethodPost {
			action := r.URL.Query().Get("action")
			if action != "cancel" && action != "restart" {
				fail(http.StatusBadRequest, "Ungültige Erfassungsaktion")
				return
			}
			mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
			if err != nil || mediaType != "application/json" || r.Body == nil {
				fail(http.StatusUnsupportedMediaType, "JSON-Anfrage erwartet")
				return
			}
			var request struct {
				RunID string `json:"runId"`
			}
			body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 256))
			if err != nil || json.Unmarshal(body, &request) != nil || !runFilename.MatchString(request.RunID+".json") {
				fail(http.StatusBadRequest, "Ungültige Erfassungs-ID")
				return
			}
			if status.State != "running" || !status.CanCancel || request.RunID != status.RunID {
				fail(http.StatusConflict, errScanNotActive.Error())
				return
			}
			if err := requestScanControl(r.Context(), dir, request.RunID, action); err != nil {
				fail(http.StatusConflict, errScanNotActive.Error())
				return
			}
			w.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(w).Encode(map[string]bool{"accepted": true})
			return
		}

		result := responseState{Status: status, User: name}
		if view != "status" && status.State != "complete" && status.Checkpoint != "" {
			current, err := readRun(filepath.Join(dir, currentFile))
			if err == nil && current.Partial && current.ID == status.RunID {
				result.Current = &current
			} else if err != nil && !errors.Is(err, os.ErrNotExist) {
				fmt.Fprintln(os.Stderr, "SynoUsage current:", err)
			}
		}
		if view != "status" && view != "current" {
			var hardware model.HardwareInfo
			if err := readJSON(filepath.Join(dir, "hardware.json"), 2<<20, &hardware); err == nil {
				dsm, kernel := collector.SystemVersions()
				if dsm != "" {
					hardware.DSM = dsm
				}
				if kernel != "" {
					hardware.Kernel = kernel
				}
				result.Hardware = &hardware
			}
			runs, err := readRuns(dir)
			if err != nil {
				fmt.Fprintln(os.Stderr, "SynoUsage history:", err)
				fail(http.StatusInternalServerError, "Die Messhistorie konnte nicht gelesen werden")
				return
			}
			result.Runs = &runs
		}
		_ = json.NewEncoder(w).Encode(result)
	})
}
