package server

import (
	"fmt"
	"log"
	"net/http"
)

func (s *Server) registerSettingsRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/settings", s.getSettings)
	mux.HandleFunc("PUT /api/v1/settings", s.putSettings)
}

func (s *Server) cleanupTasks(w http.ResponseWriter, r *http.Request) {
	var in struct {
		RoleID *int64 `json:"role_id"`
		Before string `json:"before"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	result, err := s.st.CleanupTasks(in.RoleID, in.Before)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	cleanupErrors := make([]string, 0)
	if s.ex != nil {
		for _, tk := range result.Tasks {
			if err := s.ex.CleanupTaskResources(tk); err != nil {
				msg := fmt.Sprintf("任务 #%d 资源清理失败: %v", tk.ID, err)
				cleanupErrors = append(cleanupErrors, msg)
				log.Printf("⚠ 手动历史清理：%s", msg)
			}
		}
		if _, err := s.ex.CleanupOrphanTaskSessions(); err != nil {
			msg := "孤儿 Runtime 会话清理失败: " + err.Error()
			cleanupErrors = append(cleanupErrors, msg)
			log.Printf("⚠ 手动历史清理：%s", msg)
		}
	}
	if s.artifacts != nil {
		for _, locator := range result.Locators {
			if count, countErr := s.st.CountArtifactsByLocator(locator); countErr == nil && count == 0 {
				if err := s.artifacts.Delete(r.Context(), locator); err != nil {
					msg := fmt.Sprintf("清理无引用 Artifact %s 失败: %v", locator, err)
					cleanupErrors = append(cleanupErrors, msg)
					log.Printf("⚠ 手动历史清理：%s", msg)
				}
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": result.Deleted, "cleanup_errors": cleanupErrors})
}

func (s *Server) getSettings(w http.ResponseWriter, r *http.Request) {
	all, err := s.st.AllSettings()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, all)
}

func (s *Server) putSettings(w http.ResponseWriter, r *http.Request) {
	var in map[string]string
	if !readJSON(w, r, &in) {
		return
	}
	for k, v := range in {
		if err := s.st.SetSetting(k, v); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	all, err := s.st.AllSettings()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, all)
}
