package server

import (
	"context"
	"fmt"
	osexec "os/exec"
	"strings"
)

func gitOut(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := osexec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s 失败: %v: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}
