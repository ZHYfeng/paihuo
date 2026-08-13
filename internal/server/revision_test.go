package server

import (
	"net/http"
	"strconv"
	"testing"

	"paihuo/internal/store"
)

func setTaskRevision(t *testing.T, st *store.Store, id int64, request *http.Request) {
	t.Helper()
	task, err := st.GetTask(id)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("If-Match", `"`+strconv.FormatInt(task.Revision, 10)+`"`)
}

func setRoleRevision(t *testing.T, st *store.Store, id int64, request *http.Request) {
	t.Helper()
	role, err := st.GetRole(id)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("If-Match", `"`+strconv.FormatInt(role.Revision, 10)+`"`)
}
