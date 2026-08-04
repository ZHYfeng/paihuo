// Package events 提供进程内事件总线，用于 server 与 executor 向前端推送实时更新。
package events

import (
	"encoding/json"
	"sync"
)

// Event 是推送给前端的领域事件。
type Event struct {
	Type    string `json:"type"`
	TaskID  int64  `json:"task_id,omitempty"`
	AgentID int64  `json:"agent_id,omitempty"`
	Payload any    `json:"payload"`
}

// Marshal 序列化事件；序列化失败时降级为 error 事件。
func (e Event) Marshal() []byte {
	b, err := json.Marshal(e)
	if err != nil {
		b, _ = json.Marshal(Event{Type: "error", Payload: err.Error()})
	}
	return b
}

// Hub 是广播式事件总线：每个订阅者持有自己的缓冲通道。
type Hub struct {
	mu   sync.Mutex
	subs map[chan Event]struct{}
}

func NewHub() *Hub {
	return &Hub{subs: make(map[chan Event]struct{})}
}

func (h *Hub) Subscribe() chan Event {
	ch := make(chan Event, 256)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

func (h *Hub) Unsubscribe(ch chan Event) {
	h.mu.Lock()
	delete(h.subs, ch)
	h.mu.Unlock()
}

// Publish 非阻塞广播；慢订阅者会丢事件（SSE 前端可重新拉取兜底）。
func (h *Hub) Publish(ev Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs {
		select {
		case ch <- ev:
		default:
		}
	}
}
