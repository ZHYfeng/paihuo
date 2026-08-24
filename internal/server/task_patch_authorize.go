package server

import (
	"fmt"
	"net/http"

	"paihuo/internal/exec"
	"paihuo/internal/store"
)

func (s *Server) authorizeTaskPatch(w http.ResponseWriter, id int64, cur *store.Task, patch *taskPatch) bool {
	set := patch.set
	// 合并子任务是系统状态机的一部分，来源、工作目录、权限和串行策略都
	// 不能在详情页被改坏；用户只需重试失败/取消的合并任务，或取消运行中
	// 的任务。角色例外：合并任务继承源任务角色，源角色被禁用时合并任务会
	// 永远排队并堵住项目交付链；允许为排队中的合并任务重新指派角色是唯一
	// 的解卡手段。
	if cur.MergeOf != nil {
		for key := range set {
			if key != "status" && key != "role_id" {
				writeErr(w, http.StatusConflict, "代码合并任务由系统管理；只能取消运行中任务、重试失败任务，或为排队中的任务更换角色")
				return false
			}
		}
		if _, ok := set["role_id"]; ok {
			if cur.Status != store.StatusQueued {
				writeErr(w, http.StatusConflict, "只能为排队中的合并任务更换角色")
				return false
			}
			if v, isNum := set["role_id"].(float64); !isNum || int64(v) <= 0 {
				writeErr(w, http.StatusConflict, "合并任务必须指派角色")
				return false
			}
		}
	}
	// 指派角色不会改变项目工作目录。
	if v, ok := set["role_id"]; ok {
		if aid, isNum := v.(float64); isNum && aid > 0 {
			a, err := s.st.GetRole(int64(aid))
			if err != nil {
				writeErr(w, http.StatusBadRequest, "角色不存在")
				return false
			}
			if cur.RunMode == store.RunModeInteractive && !s.ex.RuntimeService().Supports(a.RuntimeID, exec.CapabilityInteractive) {
				writeErr(w, http.StatusBadRequest, fmt.Sprintf("交互式任务要求 Runtime 支持交互模式（%s 不支持）", a.RuntimeID))
				return false
			}
			set["role_id"] = int64(aid)
		} else {
			if cur.RunMode == store.RunModeInteractive {
				writeErr(w, http.StatusBadRequest, "交互式任务必须指派角色")
				return false
			}
			set["role_id"] = nil
		}
	}

	if v, ok := set["perm"]; ok {
		p, _ := v.(string)
		if !validPerms[p] {
			writeErr(w, http.StatusBadRequest, "非法权限模式: "+p)
			return false
		}
	}
	if v, ok := set["concurrent"]; ok {
		b, isBool := v.(bool)
		if !isBool {
			writeErr(w, http.StatusBadRequest, "concurrent 必须是布尔值")
			return false
		}
		set["concurrent"] = b
	}
	if v, ok := set["block_on_failure"]; ok {
		b, isBool := v.(bool)
		if !isBool {
			writeErr(w, http.StatusBadRequest, "block_on_failure 必须是布尔值")
			return false
		}
		set["block_on_failure"] = b
	}
	if v, ok := set["project_id"]; ok {
		// 依赖目标必须和任务处于同一项目。为避免把一个已有弱/强依赖
		// 的任务悄悄移到另一条链，要求先在任务创建时选好项目；这也让
		// 历史依赖保持可解释。
		if cur.DependencyMode != store.DependencyNone || cur.DependsOn != nil {
			writeErr(w, http.StatusConflict, "带有前置依赖的任务不能修改项目")
			return false
		}
		dependent, err := s.st.FirstTaskDependent(id)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return false
		}
		if dependent != nil {
			writeErr(w, http.StatusConflict, fmt.Sprintf("任务 #%d 以本任务为前置，不能修改项目", dependent.ID))
			return false
		}
		if v == nil {
			set["project_id"] = nil
			set["project_dir"] = ""
		} else if pid, isNum := v.(float64); isNum && pid > 0 {
			project, err := s.st.GetProject(int64(pid))
			if err != nil || project == nil {
				writeErr(w, http.StatusBadRequest, "项目不存在")
				return false
			}
			set["project_id"] = int64(pid)
			set["project_dir"] = project.ProjectDir
		} else {
			writeErr(w, http.StatusBadRequest, "project_id 非法")
			return false
		}
	}
	if v, ok := set["parent_id"]; ok {
		if v == nil {
			set["parent_id"] = nil
		} else if pid, isNum := v.(float64); isNum {
			set["parent_id"] = int64(pid)
		} else {
			writeErr(w, http.StatusBadRequest, "parent_id 非法")
			return false
		}
	}
	return true
}
