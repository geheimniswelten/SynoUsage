//go:build !linux

package main

import (
	"context"
	"errors"
)

func collectOnDSM(context.Context) error {
	return errors.New("Die Erfassung benötigt Synology DSM unter Linux")
}

func runLockReleased(string) bool { return false }
