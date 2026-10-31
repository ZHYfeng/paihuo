package server

import (
	"net/http"
	"os"
	"path/filepath"

	"paihuo/internal/store"
)

func (s *Server) registerSkillRoutes(mux *routeRegistrar) {
	mux.HandleFunc("GET /api/v1/skills", s.listSkills)
	mux.HandleFunc("POST /api/v1/skills", s.createSkill)
	mux.HandleFunc("PATCH /api/v1/skills", s.patchSkills)
	mux.HandleFunc("DELETE /api/v1/skills", s.deleteSkills)
	mux.HandleFunc("POST /api/v1/skills/scan", s.scanSkills)
	mux.HandleFunc("GET /api/v1/skills/{id}", s.getSkill)
	mux.HandleFunc("PATCH /api/v1/skills/{id}", s.patchSkill)
	mux.HandleFunc("DELETE /api/v1/skills/{id}", s.deleteSkill)
}

func (s *Server) listSkills(w http.ResponseWriter, r *http.Request) {
	skills, err := s.st.ListSkills()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, skills)
}

type skillDetailResponse struct {
	store.Skill
	Content  string `json:"content"`
	FileName string `json:"file_name"`
	Size     int64  `json:"size_bytes"`
}

func (s *Server) getSkill(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	sk, err := s.st.GetSkill(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "技能不存在")
		return
	}

	path := filepath.Join(sk.Dir, "SKILL.md")
	fi, err := os.Stat(path)
	if err != nil || fi.IsDir() {
		writeErr(w, http.StatusNotFound, "技能说明文件不存在")
		return
	}
	b, err := os.ReadFile(path)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "读取技能说明失败: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, skillDetailResponse{
		Skill:    *sk,
		Content:  string(b),
		FileName: "SKILL.md",
		Size:     fi.Size(),
	})
}

// createSkill 定向添加：把源目录（含 SKILL.md）复制到 paihuo 工作目录并登记。
func (s *Server) createSkill(w http.ResponseWriter, r *http.Request) {
	var in struct {
		SourcePath string   `json:"source_path"`
		Tags       []string `json:"tags"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	src, err := skillSourceDir(in.SourcePath)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if isPathWithin(src, s.skillsDir) {
		writeErr(w, http.StatusBadRequest, "不能导入 paihuo 管理的技能库目录")
		return
	}
	if fi, err := os.Stat(filepath.Join(src, "SKILL.md")); err != nil || fi.IsDir() {
		writeErr(w, http.StatusBadRequest, "该目录没有 SKILL.md，不是技能")
		return
	}
	sk, err := s.importSkillWithTags(src, in.Tags)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, sk)
}

// skillScanResult 是一次递归扫描的结果。扫描会跳过已由 paihuo 管理的
// 技能副本，重复扫描同一个目录不会重复入库。
type skillScanResult struct {
	Found    int              `json:"found"`
	Imported []store.Skill    `json:"imported"`
	Skipped  []string         `json:"skipped"`
	Errors   []skillScanError `json:"errors"`
}

type skillScanError struct {
	SourcePath string `json:"source_path"`
	Error      string `json:"error"`
}

// scanSkills 递归寻找目录树内所有含 SKILL.md 的目录，并逐个导入。
// 单个技能导入失败不会中断其它技能，结果会在 errors 中返回给前端。
func (s *Server) scanSkills(w http.ResponseWriter, r *http.Request) {
	var in struct {
		SourcePath string   `json:"source_path"`
		Tags       []string `json:"tags"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	root, err := skillSourceDir(in.SourcePath)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if isPathWithin(root, s.skillsDir) {
		writeErr(w, http.StatusBadRequest, "不能扫描 paihuo 管理的技能库目录")
		return
	}

	dirs, err := discoverSkillDirs(r.Context(), root, s.skillsDir)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "扫描技能目录失败: "+err.Error())
		return
	}
	if len(dirs) == 0 {
		writeErr(w, http.StatusBadRequest, "目录下未发现 SKILL.md")
		return
	}

	existing, err := s.st.ListSkills()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	knownSources := make(map[string]struct{}, len(existing))
	for _, sk := range existing {
		if src, err := skillSourceDir(sk.SourcePath); err == nil {
			knownSources[src] = struct{}{}
		}
	}

	result := skillScanResult{
		Found:    len(dirs),
		Imported: make([]store.Skill, 0, len(dirs)),
		Skipped:  make([]string, 0),
		Errors:   make([]skillScanError, 0),
	}
	for _, src := range dirs {
		if _, exists := knownSources[src]; exists {
			result.Skipped = append(result.Skipped, src)
			continue
		}
		sk, err := s.importSkillWithTags(src, in.Tags)
		if err != nil {
			result.Errors = append(result.Errors, skillScanError{SourcePath: src, Error: err.Error()})
			continue
		}
		knownSources[src] = struct{}{}
		result.Imported = append(result.Imported, sk)
	}

	status := http.StatusOK
	if len(result.Imported) > 0 {
		status = http.StatusCreated
	}
	if len(result.Errors) > 0 {
		status = http.StatusMultiStatus
	}
	writeJSON(w, status, result)
}
