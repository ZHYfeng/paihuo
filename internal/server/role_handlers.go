package server

import (
	"errors"
	"log"
	"math"
	"net/http"

	"paihuo/internal/store"
)

func (s *Server) registerRoleRoutes(mux *routeRegistrar) {
	mux.HandleFunc("GET /api/v1/roles", s.listRoles)
	mux.HandleFunc("POST /api/v1/roles", s.createRole)
	mux.HandleFunc("PATCH /api/v1/roles/{id}", s.patchRole)
	mux.HandleFunc("DELETE /api/v1/roles/{id}", s.deleteRole)
}

func (s *Server) listRoles(w http.ResponseWriter, r *http.Request) {
	agents, err := s.st.ListRoles()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, agents)
}

type roleIn struct {
	Name           string           `json:"name"`
	Description    string           `json:"description"`
	RuntimeID      string           `json:"runtime_id"`
	RoleConfig     store.RoleConfig `json:"role_config"`
	MaxConcurrency int              `json:"max_concurrency"`
	// 编排委托：角色可派生子任务（子任务复用其他角色执行）。
	DelegationEnabled *bool  `json:"delegation_enabled"`
	DelegationMaxPerm string `json:"delegation_max_perm"` // full/review（空=review）
	Enabled           *bool  `json:"enabled"`
}

func (s *Server) createRole(w http.ResponseWriter, r *http.Request) {
	var in roleIn
	if !readJSON(w, r, &in) {
		return
	}
	if err := s.validateRole(&in); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	delegationPerm := normalizeDelegationMaxPerm(in.DelegationMaxPerm)
	delegationEnabled := in.DelegationEnabled != nil && *in.DelegationEnabled
	id, err := s.st.CreateRole(store.Role{
		Name: in.Name, Description: in.Description, RuntimeID: in.RuntimeID,
		RoleConfig:        in.RoleConfig,
		MaxConcurrency:    in.MaxConcurrency,
		DelegationEnabled: delegationEnabled,
		DelegationMaxPerm: delegationPerm,
		Enabled:           enabled,
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	a, err := s.st.GetRole(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, a)
}

// normalizeDelegationMaxPerm 把委托上限收敛为合法值：full/review/空 → review。
func normalizeDelegationMaxPerm(perm string) string {
	if perm == store.PermFull {
		return store.PermFull
	}
	return store.PermReview
}

func (s *Server) validateRole(in *roleIn) error {
	if in.Name == "" {
		return errMsg("角色名不能为空")
	}
	if !s.ex.RuntimeService().Has(in.RuntimeID) {
		return errMsg("未知 Runtime: " + in.RuntimeID)
	}
	if in.MaxConcurrency == 0 {
		in.MaxConcurrency = 1
	}
	if in.MaxConcurrency < 1 {
		return errMsg("最大并发数必须至少为 1")
	}
	return nil
}

type errMsg string

func (e errMsg) Error() string { return string(e) }

func (s *Server) patchRole(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	revision, ok := requiredRevision(w, r)
	if !ok {
		return
	}
	set, ok := patchMap(w, r, "name", "description", "runtime_id", "role_config", "max_concurrency", "enabled", "delegation_enabled", "delegation_max_perm")
	if !ok {
		return
	}
	if v, ok := set["name"]; ok {
		if n, _ := v.(string); n == "" {
			writeErr(w, http.StatusBadRequest, "角色名不能为空")
			return
		}
	}
	if v, ok := set["runtime_id"]; ok {
		if c, _ := v.(string); c != "" {
			if !s.ex.RuntimeService().Has(c) {
				writeErr(w, http.StatusBadRequest, "未知 Runtime: "+c)
				return
			}
		}
	}
	if v, ok := set["max_concurrency"]; ok {
		n, ok := positiveInt(v)
		if !ok {
			writeErr(w, http.StatusBadRequest, "最大并发数必须是至少为 1 的整数")
			return
		}
		set["max_concurrency"] = n
	}
	if v, ok := set["delegation_max_perm"]; ok {
		p, _ := v.(string)
		if p != "" && p != store.PermFull && p != store.PermReview {
			writeErr(w, http.StatusBadRequest, "委托最大权限只能是 full 或 review")
			return
		}
		set["delegation_max_perm"] = normalizeDelegationMaxPerm(p)
	}
	if v, ok := set["delegation_enabled"]; ok {
		b, ok := v.(bool)
		if !ok {
			writeErr(w, http.StatusBadRequest, "delegation_enabled 必须是布尔值")
			return
		}
		set["delegation_enabled"] = b
	}
	if err := s.st.UpdateAtRevision("role", id, revision, set); err != nil {
		if errors.Is(err, store.ErrRevisionConflict) {
			writeErr(w, http.StatusConflict, err.Error())
		} else {
			writeErr(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	a, err := s.st.GetRole(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	// role_config 变更（含技能选择）后立即对账角色级技能挂载目录，
	// 不必等下一次任务启动或服务重启才生效。
	if _, ok := set["role_config"]; ok {
		if _, rerr := s.ex.EnsureRoleSkills(id, a.Name, a.RoleConfig.Skills); rerr != nil {
			log.Printf("⚠ 角色 %d 技能目录对账失败: %v", id, rerr)
		}
	}
	// 提高并发数或重新启用角色后，不必等下一次一秒轮询才派发队列。
	s.ex.Wake()
	writeJSON(w, http.StatusOK, a)
}

// positiveInt 将 patchMap 的 JSON number（float64）收敛为数据库可存的正整数。
// 角色并发数没有产品级硬上限，由操作者按机器与模型配额决定；这里只拒绝
// 非整数、零、负数和超出当前平台 int 范围的值。
func positiveInt(v any) (int, bool) {
	n, ok := v.(float64)
	if !ok || n < 1 || math.Trunc(n) != n || n > float64(^uint(0)>>1) {
		return 0, false
	}
	return int(n), true
}

func (s *Server) deleteRole(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	revision, ok := requiredRevision(w, r)
	if !ok {
		return
	}
	if err := s.st.AssertRevision("role", id, revision); err != nil {
		writeErr(w, http.StatusConflict, err.Error())
		return
	}
	if err := s.st.DeleteRole(id); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	// Role 删除后立即移除技能挂载；失败不阻断数据库删除，启动对账会再扫
	// 一次无主目录。
	if err := s.ex.RemoveRoleSkills(id); err != nil {
		log.Printf("⚠ 清理角色 %d 技能目录失败: %v", id, err)
	}
	w.WriteHeader(http.StatusNoContent)
}
