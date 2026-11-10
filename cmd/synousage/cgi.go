package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"strings"
	"time"

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
	output, err := exec.CommandContext(ctx, "/usr/syno/synoman/webman/modules/authenticate.cgi").Output()
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
	Runs   *[]model.Run `json:"runs,omitempty"`
	Status scanStatus   `json:"status"`
	User   string       `json:"user"`
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
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			fail(http.StatusMethodNotAllowed, "Diese Schnittstelle liest nur Messstände")
			return
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
		status, err := readStatus(dir)
		if err != nil {
			fmt.Fprintln(os.Stderr, "SynoUsage status:", err)
			fail(http.StatusInternalServerError, "Der Erfassungsstatus konnte nicht gelesen werden")
			return
		}
		result := responseState{Status: status, User: name}
		if r.URL.Query().Get("view") != "status" {
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
