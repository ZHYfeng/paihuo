package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
)

func seedDefaultTemplate(db *sql.DB) error {
	_, err := db.Exec(`INSERT INTO templates (name, body, role_id, created_at) VALUES (?, ?, NULL, ?)`,
		createTasksTemplateName, createTasksTemplateBody, Now())
	return err
}

const (
	createTasksTemplateName = "根据对话创建任务"
	// 当前默认正文：写清「如何在本机实例调用接口创建任务、字段如何填写」，
	// agent 收到模板即可照做。
	createTasksTemplateBody = `请根据当前对话的内容，在本机部署的 PaiHuo（派活）实例中为当前项目创建一个任务。PaiHuo 即本系统，其 HTTP API 默认监听 http://127.0.0.1:8080（若连不上，请先向用户确认实例的实际地址与端口）。

按以下步骤调用接口创建任务：

1. 登录换取会话 cookie（登录只需一次，之后所有请求带同一 cookie 即可）：
   curl -s -c /tmp/paihuo.cookies -o /dev/null -d "token=$PAIHUO_TOKEN" http://127.0.0.1:8080/login
   任务进程环境通常已注入 PAIHUO_TOKEN；若环境里没有该变量，请向用户索要登录令牌再继续。

2. 查询角色与项目，确定要填的 ID：
   curl -s -b /tmp/paihuo.cookies http://127.0.0.1:8080/api/v1/roles
   curl -s -b /tmp/paihuo.cookies http://127.0.0.1:8080/api/v1/projects
   - role_id：从 /api/v1/roles 返回的数组里选合适的角色，取它的 id；
   - project_id：从 /api/v1/projects 里取与当前对话/工作目录对应的项目 id；没有对应项目就省略该字段（创建无项目任务）。

3. 创建任务（POST /api/v1/tasks，请求体为 JSON）：
   curl -s -b /tmp/paihuo.cookies -H "Content-Type: application/json" -H "Idempotency-Key: create-task-<唯一值>" -d '{"title":"任务标题","body":"给执行 agent 的完整提示词（写清目标、上下文与验收标准）","role_id":1,"project_id":2,"perm":"full","run_mode":"batch","concurrent":false,"dependency_mode":"none","depends_on":null,"block_on_failure":false}' http://127.0.0.1:8080/api/v1/tasks

字段说明：
- title：任务标题，必填；
- body：任务提示词，需包含完整上下文、目标与验收标准；
- role_id：执行角色 ID，必填，取自 /api/v1/roles；
- project_id：所属项目 ID，取自 /api/v1/projects；省略则不归属项目；
- perm：权限模式，"full"=自动执行并在成功后自动派发代码合并任务，"review"=完成后人工审批；
- run_mode："batch"=批处理（默认），"interactive"=交互式终端（仅 pi / omp 角色支持）；
- concurrent：是否允许与同项目其他任务并行；false=项目内串行（默认）；
- dependency_mode："none"=无依赖，"weak"=弱依赖（项目任务默认，按创建时间自动排队），"strong"=强依赖（必须同时提供 depends_on）；
- depends_on：强依赖的前置任务 ID；
- block_on_failure：前置任务失败时本任务是否阻塞执行；
- parent_id：父任务 ID（拆分子任务时填写，通常省略）。

创建成功返回 HTTP 201 与任务对象（含 id），请向用户报告任务编号与标题；若返回 4xx，按响应里的 error 字段修正后重试，不要重复创建相同任务。`
)

// ---------------------------------------------------------------------------
// 设置（key-value）

func (s *Store) GetSetting(key string) (string, error) {
	var v string
	err := s.db.QueryRow("SELECT value FROM settings WHERE key=?", key).Scan(&v)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return v, err
}

func (s *Store) SetSetting(key, value string) error {
	_, err := s.db.Exec(`INSERT INTO settings (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value)
	return err
}

func (s *Store) AllSettings() (map[string]string, error) {
	rows, err := s.db.Query("SELECT key, value FROM settings")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------------------
// 任务模板（技能沉淀：从成功任务保存提示词复用）

type Template struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	Body      string `json:"body"`
	RoleID    *int64 `json:"role_id"`
	RoleName  string `json:"role_name,omitempty"`
	CreatedAt string `json:"created_at"`
}

func (s *Store) ListTemplates() ([]Template, error) {
	rows, err := s.db.Query(`SELECT t.id, t.name, t.body, t.role_id, COALESCE(a.name,''), t.created_at
		FROM templates t LEFT JOIN roles a ON a.id=t.role_id ORDER BY t.id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out = make([]Template, 0)
	for rows.Next() {
		var tpl Template
		var aid sql.NullInt64
		if err := rows.Scan(&tpl.ID, &tpl.Name, &tpl.Body, &aid, &tpl.RoleName, &tpl.CreatedAt); err != nil {
			return nil, err
		}
		if aid.Valid {
			tpl.RoleID = &aid.Int64
		}
		out = append(out, tpl)
	}
	return out, rows.Err()
}

func (s *Store) CreateTemplate(tpl Template) (int64, error) {
	if tpl.CreatedAt == "" {
		tpl.CreatedAt = Now()
	}
	res, err := s.db.Exec("INSERT INTO templates (name, body, role_id, created_at) VALUES (?, ?, ?, ?)",
		tpl.Name, tpl.Body, nullInt64(tpl.RoleID), tpl.CreatedAt)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) GetTemplate(id int64) (*Template, error) {
	row := s.db.QueryRow(`SELECT t.id, t.name, t.body, t.role_id, COALESCE(a.name,''), t.created_at
		FROM templates t LEFT JOIN roles a ON a.id=t.role_id WHERE t.id=?`, id)
	var tpl Template
	var aid sql.NullInt64
	if err := row.Scan(&tpl.ID, &tpl.Name, &tpl.Body, &aid, &tpl.RoleName, &tpl.CreatedAt); err != nil {
		return nil, err
	}
	if aid.Valid {
		tpl.RoleID = &aid.Int64
	}
	return &tpl, nil
}

func (s *Store) UpdateTemplate(id int64, set map[string]any) error {
	if len(set) == 0 {
		return nil
	}
	cols := make([]string, 0, len(set))
	// cap 只取 len(set)：多出的 id 参数由 append 追加，避免 len(set)+1 溢出。
	vals := make([]any, 0, len(set))
	for k, v := range set {
		cols = append(cols, k+"=?")
		vals = append(vals, v)
	}
	vals = append(vals, id)
	_, err := s.db.Exec(fmt.Sprintf("UPDATE templates SET %s WHERE id=?", strings.Join(cols, ", ")), vals...)
	return err
}

func (s *Store) DeleteTemplate(id int64) error {
	_, err := s.db.Exec("DELETE FROM templates WHERE id=?", id)
	return err
}

// ---------------------------------------------------------------------------
// 技能库（注册到 paihuo 工作目录，角色配置时按名称勾选）

const skillCols = "id, name, description, category, tags, dir, source_path, created_at"

func scanSkill(rows scanner) (Skill, error) {
	var s Skill
	var tagsJSON string
	err := rows.Scan(&s.ID, &s.Name, &s.Description, &s.Category, &tagsJSON, &s.Dir, &s.SourcePath, &s.CreatedAt)
	if err != nil {
		return s, err
	}
	s.Tags = decodeSkillTags(tagsJSON)
	return s, err
}

func (s *Store) ListSkills() ([]Skill, error) {
	rows, err := s.db.Query("SELECT " + skillCols + " FROM skills ORDER BY name")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out = make([]Skill, 0)
	for rows.Next() {
		sk, err := scanSkill(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sk)
	}
	return out, rows.Err()
}

func (s *Store) GetSkill(id int64) (*Skill, error) {
	row := s.db.QueryRow("SELECT "+skillCols+" FROM skills WHERE id=?", id)
	sk, err := scanSkill(row)
	if err != nil {
		return nil, err
	}
	return &sk, nil
}

func (s *Store) CreateSkill(sk Skill) (int64, error) {
	if sk.CreatedAt == "" {
		sk.CreatedAt = Now()
	}
	tagsJSON, err := json.Marshal(normalizeSkillTags(sk.Tags))
	if err != nil {
		return 0, err
	}
	res, err := s.db.Exec("INSERT INTO skills (name, description, category, tags, dir, source_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		sk.Name, sk.Description, strings.TrimSpace(sk.Category), string(tagsJSON), sk.Dir, sk.SourcePath, sk.CreatedAt)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// UpdateSkillTags replaces the labels attached to a skill. Labels are stored
// as JSON so existing role configurations can continue to reference the same
// skill directory without any schema coupling.
func (s *Store) UpdateSkillTags(id int64, tags []string) error {
	tagsJSON, err := json.Marshal(normalizeSkillTags(tags))
	if err != nil {
		return err
	}
	_, err = s.db.Exec("UPDATE skills SET tags=? WHERE id=?", string(tagsJSON), id)
	return err
}

// UpdateSkillCategory 修改技能的分类（文件夹）。分类只是分组标签，不移动
// 磁盘目录，因此已引用该技能目录的角色配置不受影响。
func (s *Store) UpdateSkillCategory(id int64, category string) error {
	_, err := s.db.Exec("UPDATE skills SET category=? WHERE id=?", strings.TrimSpace(category), id)
	return err
}

// SetSkillTagsMany 在同一个事务中批量整体替换一批技能的标签。
func (s *Store) SetSkillTagsMany(ids []int64, tags []string) error {
	if len(ids) == 0 {
		return nil
	}
	tagsJSON, err := json.Marshal(normalizeSkillTags(tags))
	if err != nil {
		return err
	}
	return s.updateSkillsMany(ids, "UPDATE skills SET tags=? WHERE id=?", string(tagsJSON))
}

// SetSkillCategoryMany 在同一个事务中批量设置一批技能的分类。分类只是
// 分组标签，不移动磁盘目录，已引用该技能目录的角色配置不受影响。
func (s *Store) SetSkillCategoryMany(ids []int64, category string) error {
	if len(ids) == 0 {
		return nil
	}
	return s.updateSkillsMany(ids, "UPDATE skills SET category=? WHERE id=?", strings.TrimSpace(category))
}

// updateSkillsMany 先校验全部 id，再在同一个事务中执行批量更新，避免部分更新。
func (s *Store) updateSkillsMany(ids []int64, query, value string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmt, err := tx.Prepare(query)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, id := range ids {
		if id <= 0 {
			return fmt.Errorf("非法技能 id: %d", id)
		}
		if _, err := stmt.Exec(value, id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func normalizeSkillTags(tags []string) []string {
	out := make([]string, 0, len(tags))
	seen := make(map[string]struct{}, len(tags))
	for _, tag := range tags {
		tag = strings.TrimSpace(tag)
		if tag == "" {
			continue
		}
		key := strings.ToLower(tag)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, tag)
	}
	return out
}

func decodeSkillTags(raw string) []string {
	var tags []string
	if raw != "" {
		if err := json.Unmarshal([]byte(raw), &tags); err == nil {
			return normalizeSkillTags(tags)
		}
	}
	return []string{}
}

func (s *Store) DeleteSkill(id int64) error {
	_, err := s.db.Exec("DELETE FROM skills WHERE id=?", id)
	return err
}

// DeleteSkills 在同一个事务中删除一批技能记录。调用方负责清理技能目录副本。
func (s *Store) DeleteSkills(ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmt, err := tx.Prepare("DELETE FROM skills WHERE id=?")
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, id := range ids {
		if id <= 0 {
			return fmt.Errorf("非法技能 id: %d", id)
		}
		if _, err := stmt.Exec(id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ListTasksForCleanup 返回全部任务（worktree 清理用）。
