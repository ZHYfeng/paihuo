package server

import (
	"fmt"
	"net/http"
	"strconv"
	"time"
)

func (s *Server) registerEventRoutes(mux *routeRegistrar) {
	mux.HandleFunc("GET /api/v1/events", s.sse)
}

// ---------------------------------------------------------------------------
// SSE

func (s *Server) sse(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "SSE 不支持", http.StatusInternalServerError)
		return
	}
	after := int64(0)
	if raw := r.Header.Get("Last-Event-ID"); raw != "" {
		after, _ = strconv.ParseInt(raw, 10, 64)
	}
	if raw := r.URL.Query().Get("after"); raw != "" {
		if value, err := strconv.ParseInt(raw, 10, 64); err == nil && value > after {
			after = value
		}
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	ch := s.hub.Subscribe()
	defer s.hub.Unsubscribe(ch)
	w.WriteHeader(http.StatusOK)
	backlog, err := s.hub.History(after, 1000)
	if err != nil {
		return
	}
	last := after
	for _, event := range backlog {
		if _, err := fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", event.Seq, event.Type, event.Marshal()); err != nil {
			return
		}
		last = event.Seq
	}
	fl.Flush()

	tk := time.NewTicker(15 * time.Second)
	defer tk.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-s.hub.Closed():
			return // 服务停机：断开长连接，让 http.Server.Shutdown 立即完成
		case ev := <-ch:
			if ev.Seq <= last {
				continue
			}
			if _, err := fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", ev.Seq, ev.Type, ev.Marshal()); err != nil {
				return // 客户端已断开，立即释放连接（写失败不等待下一个周期）
			}
			last = ev.Seq
			fl.Flush()
		case <-tk.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			fl.Flush()
		}
	}
}
