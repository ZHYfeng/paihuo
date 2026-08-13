package events

import (
	"testing"

	"paihuo/internal/store"
)

func TestEventStreamPersistsAndResumesBySequence(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	stream := NewEventStream(st)
	stream.Publish(Event{Type: "task", TaskID: 7, Payload: map[string]any{"status": "running"}})
	stream.Publish(Event{Type: "task", TaskID: 7, Payload: map[string]any{"status": "succeeded"}})
	first, err := stream.History(0, 1)
	if err != nil || len(first) != 1 || first[0].Seq != 1 {
		t.Fatalf("first page=%+v err=%v", first, err)
	}
	rest, err := NewEventStream(st).History(first[0].Seq, 10)
	if err != nil || len(rest) != 1 || rest[0].Seq != 2 {
		t.Fatalf("resume page=%+v err=%v", rest, err)
	}
}

func TestEventStreamDoesNotBroadcastUnpersistedEvents(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	stream := NewEventStream(st)
	subscriber := stream.Subscribe()
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	stream.Publish(Event{Type: "task", TaskID: 9, Payload: map[string]any{"status": "running"}})
	select {
	case event := <-subscriber:
		t.Fatalf("unpersisted event was broadcast: %+v", event)
	default:
	}
}
