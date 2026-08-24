package store

import "testing"

func openTest(t *testing.T) *Store {
	t.Helper()
	s, err := Open(":memory:")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func mustRole(t *testing.T, s *Store, name string, enabled bool) int64 {
	t.Helper()
	id, err := s.CreateRole(Role{Name: name, RuntimeID: "pi", Enabled: enabled})
	if err != nil {
		t.Fatalf("CreateRole(%s): %v", name, err)
	}
	return id
}

func mustTask(t *testing.T, s *Store, title string, agentID *int64, status string, body string) int64 {
	t.Helper()
	id, err := s.CreateTask(Task{Title: title, Body: body, Status: status, RoleID: agentID})
	if err != nil {
		t.Fatalf("CreateTask(%s): %v", title, err)
	}
	return id
}
