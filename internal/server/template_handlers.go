package server

import (
	"net/http"
	"strings"

	"paihuo/internal/store"
)

func (s *Server) registerTemplateRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/templates", s.listTemplates)
	mux.HandleFunc("POST /api/v1/templates", s.createTemplate)
	mux.HandleFunc("PATCH /api/v1/templates/{id}", s.patchTemplate)
	mux.HandleFunc("DELETE /api/v1/templates/{id}", s.deleteTemplate)
}

func (s *Server) listTemplates(w http.ResponseWriter, r *http.Request) {
	templates, err := s.st.ListTemplates()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, templates)
}

func (s *Server) createTemplate(w http.ResponseWriter, r *http.Request) {
	var in store.Template
	if !readJSON(w, r, &in) {
		return
	}
	if in.Name == "" {
		writeErr(w, http.StatusBadRequest, "模板名不能为空")
		return
	}
	if in.Body == "" {
		writeErr(w, http.StatusBadRequest, "模板内容不能为空")
		return
	}
	id, err := s.st.CreateTemplate(in)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id})
}

func (s *Server) patchTemplate(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	set, ok := patchMap(w, r, "name", "body", "role_id")
	if !ok {
		return
	}
	if v, ok := set["name"]; ok {
		name, isString := v.(string)
		if !isString || strings.TrimSpace(name) == "" {
			writeErr(w, http.StatusBadRequest, "模板名不能为空")
			return
		}
		set["name"] = strings.TrimSpace(name)
	}
	if v, ok := set["body"]; ok {
		body, isString := v.(string)
		if !isString || strings.TrimSpace(body) == "" {
			writeErr(w, http.StatusBadRequest, "模板内容不能为空")
			return
		}
	}
	if v, ok := set["role_id"]; ok {
		if v == nil {
			set["role_id"] = nil
		} else if aid, isNum := v.(float64); isNum && aid > 0 {
			if _, err := s.st.GetRole(int64(aid)); err != nil {
				writeErr(w, http.StatusBadRequest, "角色不存在")
				return
			}
			set["role_id"] = int64(aid)
		} else {
			writeErr(w, http.StatusBadRequest, "role_id 非法")
			return
		}
	}
	if len(set) == 0 {
		writeErr(w, http.StatusBadRequest, "没有可更新的字段")
		return
	}
	if err := s.st.UpdateTemplate(id, set); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	tpl, err := s.st.GetTemplate(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, tpl)
}

func (s *Server) deleteTemplate(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if err := s.st.DeleteTemplate(id); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
