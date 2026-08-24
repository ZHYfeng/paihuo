package server

import (
	"fmt"
	"net/http"
	"os"

	"paihuo/internal/store"
)

func (s *Server) patchSkill(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if _, err := s.st.GetSkill(id); err != nil {
		writeErr(w, http.StatusNotFound, "技能不存在")
		return
	}
	var in struct {
		Tags     *[]string `json:"tags"`
		Category *string   `json:"category"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if in.Tags != nil {
		if err := s.st.UpdateSkillTags(id, *in.Tags); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	if in.Category != nil {
		if err := s.st.UpdateSkillCategory(id, *in.Category); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	sk, err := s.st.GetSkill(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, sk)
}

// patchSkills 批量更新技能：对选中的技能整体替换标签和/或设置分类。
// 请求中出现哪个字段就更新哪个；两个字段都出现时也支持。
func (s *Server) patchSkills(w http.ResponseWriter, r *http.Request) {
	var in struct {
		IDs      []int64   `json:"ids"`
		Tags     *[]string `json:"tags"`     // 出现则整体替换
		Category *string   `json:"category"` // 出现则设置（空字符串 = 清空为未分类）
	}
	if !readJSON(w, r, &in) {
		return
	}
	if len(in.IDs) == 0 {
		writeErr(w, http.StatusBadRequest, "至少选择一个技能")
		return
	}

	// 去重保持请求顺序；校验 id 存在，避免批量更新部分生效。
	ids := make([]int64, 0, len(in.IDs))
	seen := make(map[int64]struct{}, len(in.IDs))
	for _, id := range in.IDs {
		if id <= 0 {
			writeErr(w, http.StatusBadRequest, "非法技能 id")
			return
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		if _, err := s.st.GetSkill(id); err != nil {
			writeErr(w, http.StatusNotFound, fmt.Sprintf("技能不存在: %d", id))
			return
		}
		ids = append(ids, id)
	}

	if in.Tags != nil {
		if err := s.st.SetSkillTagsMany(ids, *in.Tags); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	if in.Category != nil {
		if err := s.st.SetSkillCategoryMany(ids, *in.Category); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	skills := make([]store.Skill, 0, len(ids))
	for _, id := range ids {
		sk, err := s.st.GetSkill(id)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		skills = append(skills, *sk)
	}
	writeJSON(w, http.StatusOK, skills)
}

func (s *Server) deleteSkill(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	sk, err := s.st.GetSkill(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "技能不存在")
		return
	}
	if err := s.st.DeleteSkill(id); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	os.RemoveAll(sk.Dir) // 登记删除后清理工作目录副本（角色引用会变成失效路径）
	writeJSON(w, http.StatusOK, map[string]any{"deleted": id})
}

// deleteSkills 批量删除技能登记和对应的工作目录副本。
// 先校验全部 id，再一次性提交数据库事务，避免部分删除。
func (s *Server) deleteSkills(w http.ResponseWriter, r *http.Request) {
	var in struct {
		IDs []int64 `json:"ids"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if len(in.IDs) == 0 {
		writeErr(w, http.StatusBadRequest, "至少选择一个技能")
		return
	}

	// 去重保持请求顺序，避免同一个技能被重复处理。
	ids := make([]int64, 0, len(in.IDs))
	seen := make(map[int64]struct{}, len(in.IDs))
	skills := make([]store.Skill, 0, len(in.IDs))
	for _, id := range in.IDs {
		if id <= 0 {
			writeErr(w, http.StatusBadRequest, "非法技能 id")
			return
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		sk, err := s.st.GetSkill(id)
		if err != nil {
			writeErr(w, http.StatusNotFound, fmt.Sprintf("技能不存在: %d", id))
			return
		}
		ids = append(ids, id)
		skills = append(skills, *sk)
	}

	if err := s.st.DeleteSkills(ids); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	for _, sk := range skills {
		os.RemoveAll(sk.Dir) // 登记删除后清理工作目录副本
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": ids, "count": len(ids)})
}
