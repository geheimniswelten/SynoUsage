package collector

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path"
	"strings"
	"time"

	"synousage/internal/model"
)

type dockerImage struct {
	ID         string   `json:"Id"`
	Tags       []string `json:"RepoTags"`
	Size       *uint64  `json:"Size"`
	SharedSize *int64   `json:"SharedSize"`
}

func dockerImages(ctx context.Context, item model.Item) ([]model.Item, string) {
	const socket = "/var/run/docker.sock"
	stat, err := os.Stat(socket)
	if err != nil || stat.Mode()&os.ModeSocket == 0 {
		return nil, ""
	}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		},
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport: transport, Timeout: 45 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	var info struct{ DockerRootDir string }
	if err := readDocker(ctx, client, "/info", &info); err != nil {
		return nil, fmt.Sprintf("%s: Docker-Details konnten nicht ermittelt werden (%v)", item.Path, err)
	}
	if path.Clean(info.DockerRootDir) != item.Path {
		return nil, "" // This daemon is using another storage path.
	}
	var usage struct{ Images []dockerImage }
	if err := readDocker(ctx, client, "/system/df", &usage); err != nil {
		return nil, fmt.Sprintf("%s: Docker-Images konnten nicht ermittelt werden (%v)", item.Path, err)
	}
	result := make([]model.Item, 0, len(usage.Images))
	for _, image := range usage.Images {
		if image.ID == "" {
			continue
		}
		title := strings.Join(image.Tags, ", ")
		if title == "" {
			title = strings.TrimPrefix(image.ID, "sha256:")
			title = title[:min(len(title), 12)]
		}
		detail := makeItem(path.Dir(item.Path), "docker", title, item.Path+" · "+image.ID, item.ID)
		detail.Metric, detail.Bytes = "docker_image", image.Size
		detail.Note = "Docker meldet die Image-Größe einschließlich gemeinsam genutzter Schichten."
		if image.SharedSize != nil && *image.SharedSize >= 0 {
			shared := uint64(*image.SharedSize)
			detail.SharedBytes = &shared
		}
		result = append(result, detail)
	}
	return result, ""
}

func readDocker(ctx context.Context, client *http.Client, endpoint string, result any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker"+endpoint, nil)
	if err != nil {
		return err
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("Docker antwortete mit HTTP %d", response.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(response.Body, 8<<20)).Decode(result)
}
