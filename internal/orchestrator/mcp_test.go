package orchestrator

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"paihuo/internal/store"
)

type rpcOut struct {
	ID     json.RawMessage `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func doMCP(t *testing.T, s *Service, token, body string) (int, rpcOut) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/mcp", strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	s.HandleHTTP(rec, req)
	var out rpcOut
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func TestMCPEndpointLifecycle(t *testing.T) {
	s, _, sessionID := newTestService(t, true, store.PermFull)
	token := s.SignToken(sessionID)

	// 未授权
	code, _ := doMCP(t, s, "", `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	if code != http.StatusUnauthorized {
		t.Fatalf("未带令牌应 401，got %d", code)
	}

	// initialize
	code, out := doMCP(t, s, token, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}`)
	if code != http.StatusOK || out.Error != nil {
		t.Fatalf("initialize 失败: %d %+v", code, out)
	}

	// tools/list：5 个工具
	_, out = doMCP(t, s, token, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	var list struct {
		Tools []toolSchema `json:"tools"`
	}
	if err := json.Unmarshal(out.Result, &list); err != nil {
		t.Fatalf("tools/list 解析失败: %v", err)
	}
	names := map[string]bool{}
	for _, tl := range list.Tools {
		names[tl.Name] = true
	}
	for _, want := range []string{toolSpawnTask, toolAwaitTasks, toolListChildren, toolGetTaskResult, toolFetchArtifact} {
		if !names[want] {
			t.Fatalf("工具面缺少 %s", want)
		}
	}

	// 未知方法
	_, out = doMCP(t, s, token, `{"jsonrpc":"2.0","id":3,"method":"whatever"}`)
	if out.Error == nil || out.Error.Code != -32601 {
		t.Fatalf("未知方法应返回 -32601: %+v", out.Error)
	}

	// 非法参数 → 工具层错误（isError content，agent 可读），非 JSON-RPC 错误
	_, out = doMCP(t, s, token, `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"spawn_task","arguments":{}}}`)
	if out.Error != nil {
		t.Fatalf("工具参数错误不应是 JSON-RPC 错误: %+v", out.Error)
	}
	var resErr struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		IsError bool `json:"isError"`
	}
	if err := json.Unmarshal(out.Result, &resErr); err != nil || !resErr.IsError || len(resErr.Content) == 0 {
		t.Fatalf("spawn_task 空参数应返回 isError: %+v", out.Result)
	}
}

func TestMCPEndpointSpawnFlow(t *testing.T) {
	s, st, sessionID := newTestService(t, true, store.PermFull)
	token := s.SignToken(sessionID)
	workerID, err := st.CreateRole(store.Role{Name: "wt", RuntimeID: "pi", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	body := `{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"spawn_task","arguments":{"role_id":%s,"title":"子系统A","body":"做 A","perm":"review"}}}`
	_, out := doMCP(t, s, token, strings.Replace(body, "%s", strconv.FormatInt(workerID, 10), 1))
	var res struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		IsError bool `json:"isError"`
	}
	if err := json.Unmarshal(out.Result, &res); err != nil {
		t.Fatalf("spawn 结果解析失败: %v", err)
	}
	if res.IsError {
		t.Fatalf("spawn 应成功: %s", res.Content)
	}
}

func intToStr(n int64) string {
	return strconv.FormatInt(n, 10)
}
