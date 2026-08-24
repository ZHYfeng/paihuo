package store

import "testing"

func TestProjectGitHubFieldsRoundTrip(t *testing.T) {
	s := openTest(t)
	roleID := mustRole(t, s, "gh-role", true)
	pid, err := s.CreateProject(Project{
		Name:               "github-project",
		ProjectDir:         "/tmp/gh",
		GitHubRepo:         "owner/repo",
		GitHubRoleID:       &roleID,
		GitHubAutoIssues:   true,
		GitHubAutoPRs:      true,
		GitHubAutoSecurity: true,
	})
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	p, err := s.GetProject(pid)
	if err != nil {
		t.Fatalf("GetProject: %v", err)
	}
	if p.GitHubRepo != "owner/repo" || p.GitHubRoleID == nil || *p.GitHubRoleID != roleID {
		t.Fatalf("github fields not persisted: %+v", p)
	}
	if !p.GitHubAutoIssues || !p.GitHubAutoPRs || !p.GitHubAutoSecurity {
		t.Fatalf("github toggles not persisted: %+v", p)
	}
}
