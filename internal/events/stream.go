// Package events provides an authoritative persisted event stream plus live
// fan-out. SSE is a transport over this module, never the source of truth.
package events

import (
	"encoding/json"
	"log"
	"sync"
	"time"

	"paihuo/internal/store"
)

// Event is the stable envelope shared by logs, task state, sessions and
// provisioning. Vendor-specific fields remain nested in Payload.
type Event struct {
	Seq       int64  `json:"seq"`
	Type      string `json:"type"`
	TaskID    int64  `json:"task_id,omitempty"`
	RoleID    int64  `json:"role_id,omitempty"`
	Payload   any    `json:"payload"`
	CreatedAt string `json:"created_at"`
}

func (e Event) Marshal() []byte {
	b, err := json.Marshal(e)
	if err != nil {
		b, _ = json.Marshal(Event{Type: "error", Payload: err.Error(), CreatedAt: time.Now().UTC().Format(time.RFC3339)})
	}
	return b
}

// EventStream persists before broadcasting. A slow live subscriber can miss
// notifications and then recover with History using the last observed seq.
type EventStream struct {
	mu      sync.Mutex
	store   *store.Store
	subs    map[chan Event]struct{}
	memory  []Event
	nextSeq int64
}

// NewEventStream accepts nil for isolated tests; production passes Store so
// reconnect survives a process restart.
func NewEventStream(st ...*store.Store) *EventStream {
	var persistence *store.Store
	if len(st) > 0 {
		persistence = st[0]
	}
	return &EventStream{store: persistence, subs: make(map[chan Event]struct{})}
}

func (s *EventStream) Subscribe() chan Event {
	ch := make(chan Event, 256)
	s.mu.Lock()
	s.subs[ch] = struct{}{}
	s.mu.Unlock()
	return ch
}

func (s *EventStream) Unsubscribe(ch chan Event) {
	s.mu.Lock()
	delete(s.subs, ch)
	s.mu.Unlock()
}

func (s *EventStream) Publish(event Event) {
	payload, err := json.Marshal(event.Payload)
	if err != nil {
		event = Event{Type: "error", Payload: err.Error()}
		payload, _ = json.Marshal(event.Payload)
	}
	if s.store != nil {
		record, err := s.store.AppendEvent(event.Type, event.TaskID, event.RoleID, payload)
		if err != nil {
			log.Printf("持久化事件失败: %v", err)
			return
		}
		event.Seq = record.Seq
		event.CreatedAt = record.CreatedAt
	}

	s.mu.Lock()
	if event.Seq == 0 {
		s.nextSeq++
		event.Seq = s.nextSeq
		if event.CreatedAt == "" {
			event.CreatedAt = time.Now().UTC().Format(time.RFC3339)
		}
		s.memory = append(s.memory, event)
		if len(s.memory) > 2000 {
			s.memory = append([]Event(nil), s.memory[len(s.memory)-1000:]...)
		}
	}
	for ch := range s.subs {
		select {
		case ch <- event:
		default:
		}
	}
	s.mu.Unlock()
}

// History returns events strictly after seq, capped to a bounded forward page.
func (s *EventStream) History(seq int64, limit int) ([]Event, error) {
	if limit <= 0 || limit > 1000 {
		limit = 500
	}
	if s.store != nil {
		records, err := s.store.ListEventsAfter(seq, limit)
		if err != nil {
			return nil, err
		}
		out := make([]Event, 0, len(records))
		for _, record := range records {
			var payload any
			if err := json.Unmarshal(record.Payload, &payload); err != nil {
				payload = map[string]any{"decode_error": err.Error()}
			}
			out = append(out, Event{Seq: record.Seq, Type: record.Type, TaskID: record.TaskID,
				RoleID: record.RoleID, Payload: payload, CreatedAt: record.CreatedAt})
		}
		return out, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Event, 0)
	for _, event := range s.memory {
		if event.Seq > seq {
			out = append(out, event)
			if len(out) == limit {
				break
			}
		}
	}
	return out, nil
}
