package server

import (
	"bufio"
	"net/http"
	"os"
	osexec "os/exec"

	"paihuo/internal/events"
	"paihuo/internal/exec"
)

func (s *Server) registerRuntimeCatalogRoutes(mux *routeRegistrar) {
	mux.HandleFunc("GET /api/v1/runtimes", s.listRuntimes)
	mux.HandleFunc("POST /api/v1/runtimes/refresh", s.refreshRuntimes)
}

func (s *Server) registerRuntimeProvisionRoutes(mux *routeRegistrar) {
	mux.HandleFunc("POST /api/v1/runtimes/install", s.provisionInstall)
	mux.HandleFunc("GET /api/v1/runtimes/provisioning", s.provisionStatus)
}

func (s *Server) listRuntimes(w http.ResponseWriter, r *http.Request) {
	items := s.ex.RuntimeService().Catalog()
	for i := range items {
		models := exec.ModelIDs(items[i].Models)
		thinkingByModel := exec.ModelThinkingOptions(items[i].Models)
		for j := range items[i].Fields {
			if items[i].Fields[j].Key == "model" {
				items[i].Fields[j].Suggestions = models
			}
			if items[i].Fields[j].Key == "thinking" && len(thinkingByModel) > 0 {
				items[i].Fields[j].ThinkingOptionsByModel = thinkingByModel
			}
		}
	}
	writeJSON(w, http.StatusOK, items)
}

// refreshRuntimes 强制从 Linux 主机重查各 CLI 的模型目录后返回 schema。
// 角色定义和 role_config 仍在 SQLite；这里仅刷新可选模型与其发现到的能力。
func (s *Server) refreshRuntimes(w http.ResponseWriter, r *http.Request) {
	exec.RefreshModelCatalogs()
	s.listRuntimes(w, r)
}

// ---------------------------------------------------------------------------
// Runtime 安装/登录状态（工作台与 Runtime 页共用）

func (s *Server) provisionStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.ex.RuntimeService().Provisioning())
}

// provisionInstall 按官方命令流式安装 CLI：输出经 SSE（provision 事件）推送，
// 前端内嵌终端实时显示；同一 CLI 并发安装互斥。
func (s *Server) provisionInstall(w http.ResponseWriter, r *http.Request) {
	var in struct {
		RuntimeID string `json:"runtime_id"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	cmd, ok := s.ex.RuntimeService().InstallCommand(in.RuntimeID)
	if !ok {
		writeErr(w, http.StatusBadRequest, "未知 Runtime: "+in.RuntimeID)
		return
	}
	if cmd == "" {
		writeErr(w, http.StatusBadRequest, "该 CLI 暂无内置安装命令，请参考官方文档手动安装")
		return
	}
	if !s.provTryLock(in.RuntimeID) {
		writeErr(w, http.StatusConflict, in.RuntimeID+" 正在安装中")
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"started": true, "runtime_id": in.RuntimeID, "cmd": cmd})
	go func() {
		defer s.provUnlock(in.RuntimeID)
		push := func(line string) {
			s.hub.Publish(events.Event{Type: "provision", Payload: map[string]any{"runtime_id": in.RuntimeID, "line": line}})
		}
		push("$ " + cmd)
		c := osexec.Command("bash", "-c", cmd)
		c.Env = os.Environ()
		out, err := c.StdoutPipe()
		if err != nil {
			push("执行失败: " + err.Error())
			return
		}
		c.Stderr = c.Stdout // 合并输出
		if err := c.Start(); err != nil {
			push("启动失败: " + err.Error())
			return
		}
		sc := bufio.NewScanner(out)
		sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for sc.Scan() {
			push(sc.Text())
		}
		if err := c.Wait(); err != nil {
			push("[install] 退出码非零: " + err.Error())
		} else {
			push("[install] 完成 ✓")
		}
	}()
}
func (s *Server) provTryLock(cli string) bool {
	s.provMu.Lock()
	defer s.provMu.Unlock()
	if s.provBusy[cli] {
		return false
	}
	s.provBusy[cli] = true
	return true
}

func (s *Server) provUnlock(cli string) {
	s.provMu.Lock()
	defer s.provMu.Unlock()
	delete(s.provBusy, cli)
}
