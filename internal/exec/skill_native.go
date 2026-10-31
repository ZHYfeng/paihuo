package exec

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"time"
)

// codexSkillCatalog queries only the local inventory API: no thread, prompt or
// inference request is created. All process output stays inside this boundary.
func codexSkillCatalog(ctx context.Context, cwd string) ([]RuntimeSkill, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "codex", "app-server", "--listen", "stdio://")
	cmd.Dir, cmd.Stderr, cmd.WaitDelay = cwd, io.Discard, 100*time.Millisecond
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, false, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, false, err
	}
	if err = cmd.Start(); err != nil {
		return nil, false, err
	}
	defer func() { _ = stdin.Close(); _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	encoder := json.NewEncoder(stdin)
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 4096), 8<<20)
	read := func(id int, target any) error {
		for scanner.Scan() {
			var message struct {
				ID     *int            `json:"id"`
				Result json.RawMessage `json:"result"`
				Error  json.RawMessage `json:"error"`
			}
			if json.Unmarshal(scanner.Bytes(), &message) != nil || message.ID == nil || *message.ID != id {
				continue
			}
			if len(message.Error) > 0 {
				return fmt.Errorf("原生技能目录查询失败")
			}
			return json.Unmarshal(message.Result, target)
		}
		return fmt.Errorf("原生技能目录查询未完成")
	}
	if err = encoder.Encode(map[string]any{"id": 1, "method": "initialize", "params": map[string]any{"clientInfo": map[string]string{"name": "paihuo-inspection", "version": "dev"}}}); err != nil {
		return nil, false, err
	}
	var initialized json.RawMessage
	if err = read(1, &initialized); err != nil {
		return nil, false, err
	}
	if err = encoder.Encode(map[string]any{"method": "initialized"}); err != nil {
		return nil, false, err
	}
	if err = encoder.Encode(map[string]any{"id": 2, "method": "skills/list", "params": map[string]any{"cwds": []string{cwd}, "forceReload": true}}); err != nil {
		return nil, false, err
	}
	var result struct {
		Data []struct {
			Skills []struct {
				Name, Description, Path, Scope, PluginID string
				Enabled                                  *bool
			} `json:"skills"`
			Errors []json.RawMessage `json:"errors"`
		} `json:"data"`
	}
	if err = read(2, &result); err != nil {
		return nil, false, err
	}
	if len(result.Data) == 0 {
		return nil, false, fmt.Errorf("原生技能目录没有返回当前目录")
	}
	skills := []RuntimeSkill{}
	complete := true
	for _, entry := range result.Data {
		complete = complete && len(entry.Errors) == 0
		for _, skill := range entry.Skills {
			source := "Codex 原生目录"
			if skill.PluginID != "" {
				source = skill.PluginID
			}
			skills = append(skills, RuntimeSkill{Name: skill.Name, Description: skill.Description, Path: skill.Path, Scope: skill.Scope, Source: source, Enabled: skill.Enabled})
		}
	}
	return skills, complete, nil
}

func piSkillCatalog(ctx context.Context, cwd string) ([]RuntimeSkill, error) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "pi", "--mode", "rpc", "--offline", "--no-extensions", "--no-mcp", "--no-session", "--approve")
	cmd.Dir, cmd.Stderr, cmd.WaitDelay = cwd, io.Discard, 100*time.Millisecond
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err = cmd.Start(); err != nil {
		return nil, err
	}
	defer func() { _ = stdin.Close(); _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	if err = json.NewEncoder(stdin).Encode(map[string]string{"id": "paihuo-skills", "type": "get_commands"}); err != nil {
		return nil, err
	}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 4096), 8<<20)
	for scanner.Scan() {
		var message struct {
			ID      string `json:"id"`
			Success bool   `json:"success"`
			Data    struct {
				Commands []struct {
					Name, Description, Source string
					SourceInfo                struct{ Path, Source, Scope string } `json:"sourceInfo"`
				} `json:"commands"`
			} `json:"data"`
		}
		if json.Unmarshal(scanner.Bytes(), &message) != nil || message.ID != "paihuo-skills" {
			continue
		}
		if !message.Success {
			return nil, fmt.Errorf("Pi 原生技能目录查询失败")
		}
		skills := []RuntimeSkill{}
		for _, command := range message.Data.Commands {
			if command.Source != "skill" {
				continue
			}
			if command.SourceInfo.Path == "" {
				return nil, fmt.Errorf("Pi 版本没有返回技能来源")
			}
			skills = append(skills, RuntimeSkill{Name: strings.TrimPrefix(command.Name, "skill:"), Description: command.Description, Path: command.SourceInfo.Path, Scope: command.SourceInfo.Scope, Source: "Pi 原生目录", Enabled: boolPointer(true)})
		}
		return skills, nil
	}
	return nil, fmt.Errorf("Pi 原生技能目录查询未完成")
}
