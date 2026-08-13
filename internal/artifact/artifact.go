// Package artifact owns immutable, content-addressed task and workflow outputs.
package artifact

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type Object struct {
	Hash    string
	Size    int64
	Locator string
}

type Metadata struct {
	ID          int64  `json:"id"`
	TaskID      *int64 `json:"task_id,omitempty"`
	RunID       *int64 `json:"run_id,omitempty"`
	Name        string `json:"name"`
	MediaType   string `json:"media_type"`
	ContentHash string `json:"content_hash"`
	Size        int64  `json:"size"`
	Locator     string `json:"locator"`
	CreatedBy   string `json:"created_by"`
	Retention   string `json:"retention"`
	CreatedAt   string `json:"created_at"`
}

type Store interface {
	Put(context.Context, io.Reader) (Object, error)
	Open(context.Context, string) (io.ReadCloser, error)
	Delete(context.Context, string) error
}

// LocalStore uses sha256/<prefix>/<hash> locators. Callers never provide a
// filesystem path, so artifact reads cannot escape the managed root.
type LocalStore struct{ root string }

func NewLocalStore(root string) (*LocalStore, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	return &LocalStore{root: root}, nil
}

func (s *LocalStore) Put(ctx context.Context, source io.Reader) (Object, error) {
	tmp, err := os.CreateTemp(s.root, ".upload-*")
	if err != nil {
		return Object{}, err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	hash := sha256.New()
	size, err := io.Copy(io.MultiWriter(tmp, hash), &contextReader{ctx: ctx, reader: source})
	closeErr := tmp.Close()
	if err != nil {
		return Object{}, err
	}
	if closeErr != nil {
		return Object{}, closeErr
	}
	digest := hex.EncodeToString(hash.Sum(nil))
	locator := filepath.ToSlash(filepath.Join("sha256", digest[:2], digest))
	target := filepath.Join(s.root, filepath.FromSlash(locator))
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return Object{}, err
	}
	if _, err := os.Stat(target); err == nil {
		return Object{Hash: digest, Size: size, Locator: locator}, nil
	}
	if err := os.Rename(tmpName, target); err != nil {
		return Object{}, err
	}
	return Object{Hash: digest, Size: size, Locator: locator}, nil
}

func (s *LocalStore) Open(_ context.Context, locator string) (io.ReadCloser, error) {
	path, err := s.path(locator)
	if err != nil {
		return nil, err
	}
	return os.Open(path)
}

func (s *LocalStore) Delete(_ context.Context, locator string) error {
	path, err := s.path(locator)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func (s *LocalStore) path(locator string) (string, error) {
	clean := filepath.ToSlash(filepath.Clean(locator))
	parts := strings.Split(clean, "/")
	if len(parts) != 3 || parts[0] != "sha256" || len(parts[1]) != 2 || len(parts[2]) != 64 || parts[1] != parts[2][:2] {
		return "", fmt.Errorf("invalid artifact locator")
	}
	if _, err := hex.DecodeString(parts[2]); err != nil {
		return "", fmt.Errorf("invalid artifact locator")
	}
	return filepath.Join(s.root, filepath.FromSlash(clean)), nil
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *contextReader) Read(p []byte) (int, error) {
	select {
	case <-r.ctx.Done():
		return 0, r.ctx.Err()
	default:
		return r.reader.Read(p)
	}
}
