package server

import (
	"bytes"
	"database/sql"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"

	"paihuo/internal/artifact"
)

const maxArtifactBody = 16 << 20

func (s *Server) artifactRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/artifacts", s.listArtifacts)
	mux.HandleFunc("POST /api/v1/artifacts", s.createArtifact)
	mux.HandleFunc("GET /api/v1/artifacts/{id}", s.getArtifact)
	mux.HandleFunc("GET /api/v1/artifacts/{id}/content", s.getArtifactContent)
	mux.HandleFunc("DELETE /api/v1/artifacts/{id}", s.deleteArtifact)
}

func (s *Server) listArtifacts(w http.ResponseWriter, r *http.Request) {
	taskID, ok := optionalQueryID(w, r, "task_id")
	if !ok {
		return
	}
	runID, ok := optionalQueryID(w, r, "run_id")
	if !ok {
		return
	}
	items, err := s.st.ListArtifacts(taskID, runID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) createArtifact(w http.ResponseWriter, r *http.Request) {
	if s.artifacts == nil {
		writeErr(w, http.StatusServiceUnavailable, "ArtifactStore 不可用")
		return
	}
	var input struct {
		TaskID    *int64 `json:"task_id"`
		RunID     *int64 `json:"run_id"`
		Name      string `json:"name"`
		MediaType string `json:"media_type"`
		Content   []byte `json:"content"`
		CreatedBy string `json:"created_by"`
		Retention string `json:"retention"`
	}
	if !readJSONLimit(w, r, &input, maxArtifactBody) {
		return
	}
	if (input.TaskID == nil) == (input.RunID == nil) {
		writeErr(w, http.StatusBadRequest, "artifact 必须且只能归属一个 Task 或 Workflow Run")
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" || len(input.Content) == 0 {
		writeErr(w, http.StatusBadRequest, "artifact 名称和内容不能为空")
		return
	}
	if input.MediaType == "" {
		input.MediaType = "application/octet-stream"
	}
	if input.CreatedBy == "" {
		input.CreatedBy = "operator"
	}
	object, err := s.artifacts.Put(r.Context(), bytes.NewReader(input.Content))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	item, err := s.st.CreateArtifact(artifact.Metadata{TaskID: input.TaskID, RunID: input.RunID, Name: input.Name, MediaType: input.MediaType, ContentHash: object.Hash, Size: object.Size, Locator: object.Locator, CreatedBy: input.CreatedBy, Retention: input.Retention})
	if err != nil {
		if count, countErr := s.st.CountArtifactsByLocator(object.Locator); countErr == nil && count == 0 {
			_ = s.artifacts.Delete(r.Context(), object.Locator)
		}
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (s *Server) getArtifact(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	item, err := s.st.GetArtifact(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "artifact 不存在")
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (s *Server) getArtifactContent(w http.ResponseWriter, r *http.Request) {
	if s.artifacts == nil {
		writeErr(w, http.StatusServiceUnavailable, "ArtifactStore 不可用")
		return
	}
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	item, err := s.st.GetArtifact(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "artifact 不存在")
		return
	}
	reader, err := s.artifacts.Open(r.Context(), item.Locator)
	if err != nil {
		writeErr(w, http.StatusNotFound, "artifact 内容不存在")
		return
	}
	defer reader.Close()
	w.Header().Set("Content-Type", item.MediaType)
	w.Header().Set("Content-Length", strconv.FormatInt(item.Size, 10))
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": item.Name}))
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, reader)
}

func (s *Server) deleteArtifact(w http.ResponseWriter, r *http.Request) {
	if s.artifacts == nil {
		writeErr(w, http.StatusServiceUnavailable, "ArtifactStore 不可用")
		return
	}
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	item, err := s.st.GetArtifact(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "artifact 不存在")
		return
	}
	if err := s.st.DeleteArtifact(id); err != nil && err != sql.ErrNoRows {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if count, _ := s.st.CountArtifactsByLocator(item.Locator); count == 0 {
		_ = s.artifacts.Delete(r.Context(), item.Locator)
	}
	w.WriteHeader(http.StatusNoContent)
}

func optionalQueryID(w http.ResponseWriter, r *http.Request, key string) (*int64, bool) {
	raw := r.URL.Query().Get(key)
	if raw == "" {
		return nil, true
	}
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id < 1 {
		writeErr(w, http.StatusBadRequest, key+" 非法")
		return nil, false
	}
	return &id, true
}
