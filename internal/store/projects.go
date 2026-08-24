package store

import "database/sql"

// ---------------------------------------------------------------------------
// 项目（projects）

const projectCols = "id, name, description, status, project_dir, github_repo, github_role_id, github_auto_issues, github_auto_prs, github_auto_security, revision, created_at, updated_at"

func scanProject(rows scanner) (Project, error) {
	var p Project
	var roleID sql.NullInt64
	var autoIssues, autoPRs, autoSecurity int64
	err := rows.Scan(&p.ID, &p.Name, &p.Description, &p.Status, &p.ProjectDir, &p.GitHubRepo, &roleID, &autoIssues, &autoPRs, &autoSecurity, &p.Revision, &p.CreatedAt, &p.UpdatedAt)
	if roleID.Valid {
		p.GitHubRoleID = &roleID.Int64
	}
	p.GitHubAutoIssues = autoIssues != 0
	p.GitHubAutoPRs = autoPRs != 0
	p.GitHubAutoSecurity = autoSecurity != 0
	return p, err
}

func (s *Store) ListProjects() ([]Project, error) {
	rows, err := s.db.Query("SELECT " + projectCols + " FROM projects ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out = make([]Project, 0)
	for rows.Next() {
		p, err := scanProject(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) GetProject(id int64) (*Project, error) {
	row := s.db.QueryRow("SELECT "+projectCols+" FROM projects WHERE id=?", id)
	p, err := scanProject(row)
	if err != nil {
		return nil, err
	}
	return &p, nil
}

func (s *Store) CreateProject(p Project) (int64, error) {
	if p.CreatedAt == "" {
		p.CreatedAt = Now()
	}
	if p.UpdatedAt == "" {
		p.UpdatedAt = p.CreatedAt
	}
	if p.Status == "" {
		p.Status = "active"
	}
	res, err := s.db.Exec("INSERT INTO projects (name, description, status, project_dir, github_repo, github_role_id, github_auto_issues, github_auto_prs, github_auto_security, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		p.Name, p.Description, p.Status, p.ProjectDir, p.GitHubRepo, nullInt64(p.GitHubRoleID), boolInt(p.GitHubAutoIssues), boolInt(p.GitHubAutoPRs), boolInt(p.GitHubAutoSecurity), p.CreatedAt, p.UpdatedAt)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// DeleteProject 删除项目；项目下任务改为「无项目」而非级联删除。
func (s *Store) DeleteProject(id int64) error {
	if _, err := s.db.Exec("UPDATE tasks SET project_id=NULL, updated_at=?, revision=revision+1 WHERE project_id=?", Now(), id); err != nil {
		return err
	}
	_, err := s.db.Exec("DELETE FROM projects WHERE id=?", id)
	return err
}
