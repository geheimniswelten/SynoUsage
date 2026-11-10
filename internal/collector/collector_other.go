//go:build !linux

package collector

import (
	"context"
	"errors"

	"synousage/internal/model"
)

func Collect(_ context.Context, _ func(phase, current string, done, total int)) (model.Run, error) {
	return model.Run{}, errors.New("Die Speichererfassung benötigt Linux")
}
