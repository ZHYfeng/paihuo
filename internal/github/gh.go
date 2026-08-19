// Package github 封装本机已安装的 gh CLI，避免重复实现 GitHub API client。
package github

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

type Client struct{}

func NewClient() *Client { return &Client{} }

type Issue struct {
	Number    int    `json:"number"`
	Title     string `json:"title"`
	Body      string `json:"body"`
	URL       string `json:"url"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

type PullRequest struct {
	Number int    `json:"number"`
	Title  string `json:"title"`
	Body   string `json:"body"`
	URL    string `json:"url"`
	Author struct {
		Login string `json:"login"`
	} `json:"author"`
	IsDraft     bool   `json:"isDraft"`
	HeadRefName string `json:"headRefName"`
	BaseRefName string `json:"baseRefName"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
}

type Alert struct {
	Number           int    `json:"number"`
	State            string `json:"state"`
	HTMLURL          string `json:"html_url"`
	CreatedAt        string `json:"created_at"`
	UpdatedAt        string `json:"updated_at"`
	SecurityAdvisory *struct {
		GHSAID  string `json:"ghsa_id"`
		Summary string `json:"summary"`
	} `json:"security_advisory,omitempty"`
	Dependency *struct {
		Package *struct {
			Name string `json:"name"`
		} `json:"package"`
		ManifestPath string `json:"manifest_path"`
		Scope        string `json:"scope"`
	} `json:"dependency,omitempty"`
	SecretType string `json:"secret_type,omitempty"`
	Location   *struct {
		Path string `json:"path"`
	} `json:"location,omitempty"`
}

func (c *Client) ListIssues(ctx context.Context, repo string) ([]Issue, error) {
	out, err := c.run(ctx, "issue", "list", "--repo", repo, "--state", "open", "--json", "number,title,body,url,createdAt,updatedAt")
	if err != nil {
		return nil, err
	}
	var items []Issue
	if err := json.Unmarshal(out, &items); err != nil {
		return nil, fmt.Errorf("解析 gh issue list 输出失败: %w", err)
	}
	return items, nil
}

func (c *Client) ListPullRequests(ctx context.Context, repo string) ([]PullRequest, error) {
	out, err := c.run(ctx, "pr", "list", "--repo", repo, "--state", "open", "--json", "number,title,body,url,author,isDraft,headRefName,baseRefName,createdAt,updatedAt")
	if err != nil {
		return nil, err
	}
	var items []PullRequest
	if err := json.Unmarshal(out, &items); err != nil {
		return nil, fmt.Errorf("解析 gh pr list 输出失败: %w", err)
	}
	return items, nil
}

func (c *Client) ListDependabotAlerts(ctx context.Context, repo string) ([]Alert, error) {
	path := "/repos/" + repo + "/dependabot/alerts?state=open&per_page=100"
	out, err := c.run(ctx, "api", path)
	if err != nil {
		return nil, err
	}
	var items []Alert
	if err := json.Unmarshal(out, &items); err != nil {
		return nil, fmt.Errorf("解析 dependabot alerts 失败: %w", err)
	}
	return items, nil
}

func (c *Client) ListSecretScanningAlerts(ctx context.Context, repo string) ([]Alert, error) {
	path := "/repos/" + repo + "/secret-scanning/alerts?state=open&per_page=100"
	out, err := c.run(ctx, "api", path)
	if err != nil {
		return nil, err
	}
	var items []Alert
	if err := json.Unmarshal(out, &items); err != nil {
		return nil, fmt.Errorf("解析 secret scanning alerts 失败: %w", err)
	}
	return items, nil
}

func (c *Client) CreatePullRequest(ctx context.Context, repo, head, base, title, body string) (string, error) {
	args := []string{"pr", "create", "--repo", repo, "--head", head, "--base", base, "--title", title}
	if body != "" {
		args = append(args, "--body", body)
	}
	out, err := c.run(ctx, args...)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func (c *Client) run(ctx context.Context, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "gh", args...)
	out, err := cmd.Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return nil, fmt.Errorf("gh %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(ee.Stderr)))
		}
		return nil, fmt.Errorf("gh %s: %w", strings.Join(args, " "), err)
	}
	return out, nil
}
