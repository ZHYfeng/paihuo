package server

import "net/http"

func (s *Server) deleteTask(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	revision, ok := requiredRevision(w, r)
	if !ok {
		return
	}
	if err := s.tasks.Delete(r.Context(), id, revision); err != nil {
		writeTaskLifecycleError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
