package server

import (
	"bytes"
	"log"
	"net/http"
	"regexp"
	"strings"
)

var idempotencyKeyPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{8,128}$`)

func (s *Server) withIdempotency(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/v1/") || !isMutation(r.Method) {
			next.ServeHTTP(w, r)
			return
		}
		key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
		if key == "" {
			next.ServeHTTP(w, r)
			return
		}
		if !idempotencyKeyPattern.MatchString(key) {
			writeErr(w, http.StatusBadRequest, "Idempotency-Key 必须是 8-128 位安全字符")
			return
		}
		record, owner, err := s.st.ReserveIdempotency(key, r.Method, r.URL.Path)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		if !owner {
			if record.StatusCode == 0 {
				writeErr(w, http.StatusConflict, "相同幂等请求仍在执行")
				return
			}
			w.Header().Set("Idempotency-Replayed", "true")
			if len(record.Body) > 0 {
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
			}
			w.WriteHeader(record.StatusCode)
			_, _ = w.Write(record.Body)
			return
		}
		capture := &responseCapture{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(capture, r)
		if err := s.st.CompleteIdempotency(key, r.Method, r.URL.Path, capture.status, capture.body.Bytes()); err != nil {
			// 响应已发出，无法再改状态码；失败会让记录停留在“执行中”，
			// 后续同键重放会得到 409。记录日志便于发现此类问题。
			log.Printf("幂等记录完成失败 key=%s method=%s path=%s: %v", key, r.Method, r.URL.Path, err)
		}
	})
}

func isMutation(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	default:
		return false
	}
}

type responseCapture struct {
	http.ResponseWriter
	status int
	body   bytes.Buffer
}

func (w *responseCapture) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *responseCapture) Write(data []byte) (int, error) {
	if w.body.Len()+len(data) <= 2<<20 {
		_, _ = w.body.Write(data)
	}
	return w.ResponseWriter.Write(data)
}
