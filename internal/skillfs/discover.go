// Package skillfs discovers skill files while following directory symlinks once.
package skillfs

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type Options struct {
	Exclude        []string
	RootMarkdown   bool
	NestedMarkdown bool
	StopAtSkill    bool
}

// Discover follows links to their canonical targets, contains cycles and excludes
// managed copies even when reached through a link. A missing root is an empty
// inventory. Unreadable roots and bounded traversal failures remain observable.
func Discover(ctx context.Context, root string, options Options) ([]string, error) {
	var excludes []string
	for _, dir := range options.Exclude {
		if dir == "" {
			continue
		}
		abs, _ := filepath.Abs(dir)
		if resolved, err := filepath.EvalSymlinks(abs); err == nil {
			abs = resolved
		}
		excludes = append(excludes, filepath.Clean(abs))
	}
	files := make(map[string]bool)
	seen := make(map[string]bool)
	var visit func(string, int) error
	visit = func(path string, depth int) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		canonical, err := filepath.EvalSymlinks(path)
		if os.IsNotExist(err) || err != nil && strings.Contains(err.Error(), "too many links") {
			return nil
		}
		if err != nil {
			return err
		}
		canonical, err = filepath.Abs(canonical)
		if err != nil {
			return err
		}
		for _, dir := range excludes {
			rel, err := filepath.Rel(dir, canonical)
			if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
				return nil
			}
		}
		if seen[canonical] {
			return nil
		}
		seen[canonical] = true
		if len(seen) > 25000 {
			return fmt.Errorf("技能扫描目录过多，请缩小扫描范围")
		}
		info, err := os.Stat(canonical)
		if err != nil {
			return err
		}
		if !info.IsDir() {
			markdown := strings.HasSuffix(info.Name(), ".md") && (options.RootMarkdown && depth <= 1 || options.NestedMarkdown && depth > 1)
			if info.Mode().IsRegular() && (info.Name() == "SKILL.md" || markdown) {
				files[canonical] = true
			}
			return nil
		}
		entries, err := os.ReadDir(canonical)
		if err != nil {
			return err
		}
		if options.StopAtSkill {
			if skill, err := os.Stat(filepath.Join(canonical, "SKILL.md")); err == nil && skill.Mode().IsRegular() {
				return visit(filepath.Join(canonical, "SKILL.md"), depth+1)
			}
		}
		for _, entry := range entries {
			if entry.Name() == ".git" {
				continue
			}
			markdown := strings.HasSuffix(entry.Name(), ".md") && (options.RootMarkdown && depth == 0 || options.NestedMarkdown && depth > 0)
			if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 || entry.Name() == "SKILL.md" || markdown {
				if err := visit(filepath.Join(canonical, entry.Name()), depth+1); err != nil {
					return err
				}
			}
		}
		return nil
	}
	err := visit(root, 0)
	out := make([]string, 0, len(files))
	for path := range files {
		out = append(out, path)
	}
	sort.Strings(out)
	return out, err
}
