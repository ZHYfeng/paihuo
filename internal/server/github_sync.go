package server

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"paihuo/internal/application"
	"paihuo/internal/github"
	"paihuo/internal/store"
)

// startGitHubSync 周期性扫描开启了 GitHub 自动处理的项目，使用本机 gh CLI 获取数据。
func (s *Server) startGitHubSync(ctx context.Context) {
	interval := 2 * time.Minute
	if v := os.Getenv("PAIHUO_GITHUB_SYNC_INTERVAL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			interval = d
		}
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	// 启动后先执行一次，避免要等一个周期。
	s.syncAllGitHubProjects(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.syncAllGitHubProjects(ctx)
		}
	}
}

func (s *Server) syncAllGitHubProjects(ctx context.Context) {
	projects, err := s.st.ListProjects()
	if err != nil {
		log.Printf("GitHub 同步：读取项目失败: %v", err)
		return
	}
	for _, p := range projects {
		if strings.TrimSpace(p.GitHubRepo) == "" {
			continue
		}
		if !p.GitHubAutoIssues && !p.GitHubAutoPRs && !p.GitHubAutoSecurity {
			continue
		}
		if err := s.syncGitHubProject(ctx, p); err != nil {
			log.Printf("GitHub 同步：项目 %s 同步失败: %v", p.Name, err)
		}
	}
}

func (s *Server) syncGitHubProject(ctx context.Context, p store.Project) error {
	repo := strings.TrimSpace(p.GitHubRepo)
	if repo == "" {
		return nil
	}
	if p.GitHubAutoIssues {
		if err := s.syncIssues(ctx, p, repo); err != nil {
			return fmt.Errorf("issues: %w", err)
		}
	}
	if p.GitHubAutoPRs {
		if err := s.syncPullRequests(ctx, p, repo); err != nil {
			return fmt.Errorf("PRs: %w", err)
		}
	}
	if p.GitHubAutoSecurity {
		if err := s.syncAlerts(ctx, p, repo, "dependabot"); err != nil {
			log.Printf("GitHub 同步：项目 %s dependabot 告警同步失败: %v", p.Name, err)
		}
		if err := s.syncAlerts(ctx, p, repo, "secret"); err != nil {
			log.Printf("GitHub 同步：项目 %s secret scanning 告警同步失败: %v", p.Name, err)
		}
	}
	return nil
}

func (s *Server) syncIssues(ctx context.Context, p store.Project, repo string) error {
	items, err := s.gh.ListIssues(ctx, repo)
	if err != nil {
		return err
	}
	for _, item := range items {
		key := fmt.Sprintf("github:issue:%s:%d", repo, item.Number)
		exists, err := s.st.TaskExistsByExternalKey(key)
		if err != nil {
			return err
		}
		if exists {
			continue
		}
		_, err = s.tasks.Create(application.CreateTaskRequest{
			Title:          fmt.Sprintf("GitHub Issue #%d: %s", item.Number, item.Title),
			Body:           fmt.Sprintf("来源：%s\n\n%s", item.URL, item.Body),
			RoleID:         p.GitHubRoleID,
			ProjectID:      &p.ID,
			ExternalKey:    key,
			Permission:     store.PermFull,
			RunMode:        store.RunModeBatch,
			DependencyMode: store.DependencyWeak,
		})
		if err != nil {
			return fmt.Errorf("创建 issue #%d 任务失败: %w", item.Number, err)
		}
		log.Printf("GitHub 集成：项目 %s 为 issue #%d 创建任务", p.Name, item.Number)
	}
	return nil
}

func (s *Server) syncPullRequests(ctx context.Context, p store.Project, repo string) error {
	items, err := s.gh.ListPullRequests(ctx, repo)
	if err != nil {
		return err
	}
	for _, item := range items {
		key := fmt.Sprintf("github:pr:%s:%d", repo, item.Number)
		exists, err := s.st.TaskExistsByExternalKey(key)
		if err != nil {
			return err
		}
		if exists {
			continue
		}
		body := fmt.Sprintf("来源：%s\n作者：%s\n分支：%s -> %s\n\n%s",
			item.URL, item.Author.Login, item.HeadRefName, item.BaseRefName, item.Body)
		_, err = s.tasks.Create(application.CreateTaskRequest{
			Title:          fmt.Sprintf("GitHub PR #%d: %s", item.Number, item.Title),
			Body:           body,
			RoleID:         p.GitHubRoleID,
			ProjectID:      &p.ID,
			ExternalKey:    key,
			Permission:     store.PermFull,
			RunMode:        store.RunModeBatch,
			DependencyMode: store.DependencyWeak,
		})
		if err != nil {
			return fmt.Errorf("创建 PR #%d 任务失败: %w", item.Number, err)
		}
		log.Printf("GitHub 集成：项目 %s 为 PR #%d 创建任务", p.Name, item.Number)
	}
	return nil
}

func (s *Server) syncAlerts(ctx context.Context, p store.Project, repo, kind string) error {
	var items []github.Alert
	var err error
	if kind == "dependabot" {
		items, err = s.gh.ListDependabotAlerts(ctx, repo)
	} else {
		items, err = s.gh.ListSecretScanningAlerts(ctx, repo)
	}
	if err != nil {
		return err
	}
	label := "Dependabot"
	if kind == "secret" {
		label = "Secret Scanning"
	}
	for _, item := range items {
		key := fmt.Sprintf("github:%s:%s:%d", kind, repo, item.Number)
		exists, err := s.st.TaskExistsByExternalKey(key)
		if err != nil {
			return err
		}
		if exists {
			continue
		}
		detail := alertDetail(item)
		title := fmt.Sprintf("GitHub %s 告警 #%d", label, item.Number)
		_, err = s.tasks.Create(application.CreateTaskRequest{
			Title:          title,
			Body:           fmt.Sprintf("来源：%s\n%s", item.HTMLURL, detail),
			RoleID:         p.GitHubRoleID,
			ProjectID:      &p.ID,
			ExternalKey:    key,
			Permission:     store.PermFull,
			RunMode:        store.RunModeBatch,
			DependencyMode: store.DependencyWeak,
		})
		if err != nil {
			return fmt.Errorf("创建 %s 告警 #%d 任务失败: %w", label, item.Number, err)
		}
		log.Printf("GitHub 集成：项目 %s 为 %s 告警 #%d 创建任务", p.Name, label, item.Number)
	}
	return nil
}

func alertDetail(a github.Alert) string {
	var parts []string
	if a.SecurityAdvisory != nil {
		if a.SecurityAdvisory.GHSAID != "" {
			parts = append(parts, "GHSA: "+a.SecurityAdvisory.GHSAID)
		}
		if a.SecurityAdvisory.Summary != "" {
			parts = append(parts, "摘要: "+a.SecurityAdvisory.Summary)
		}
	}
	if a.Dependency != nil {
		if a.Dependency.Package != nil && a.Dependency.Package.Name != "" {
			parts = append(parts, "依赖包: "+a.Dependency.Package.Name)
		}
		if a.Dependency.ManifestPath != "" {
			parts = append(parts, "清单: "+a.Dependency.ManifestPath)
		}
	}
	if a.SecretType != "" {
		parts = append(parts, "密钥类型: "+a.SecretType)
	}
	if a.Location != nil && a.Location.Path != "" {
		parts = append(parts, "位置: "+a.Location.Path)
	}
	if len(parts) == 0 {
		return "状态: " + a.State
	}
	return strings.Join(parts, "\n")
}

func (s *Server) syncGitHubProjectHandler(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	p, err := s.st.GetProject(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "项目不存在")
		return
	}
	if err := s.syncGitHubProject(r.Context(), *p); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"synced": true})
}
