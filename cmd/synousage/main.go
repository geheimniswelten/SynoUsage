package main

import (
	"context"
	"fmt"
	"net/http/cgi"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
)

const (
	dataDir     = "/var/lib/h5uSynoUsage"
	enabledFile = "/var/packages/h5uSynoUsage/var/enabled"
)

func main() {
	if filepath.Base(os.Args[0]) == "api.cgi" {
		if err := cgi.Serve(stateHandler(dataDir, enabledFile, authenticateDSM)); err != nil {
			fmt.Fprintln(os.Stderr, "SynoUsage CGI:", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) != 2 || os.Args[1] != "collect" {
		fmt.Fprintln(os.Stderr, "Aufruf: synousage collect")
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := collectOnDSM(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "SynoUsage:", err)
		os.Exit(1)
	}
}
