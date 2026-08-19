package session

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	osexec "os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// dshAPI：信封、方法路由、错误分支。
func TestDSHAPICall(t *testing.T) {
	var calls []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.URL.Path)
		var env struct {
			Type    string          `json:"type"`
			RPCID   string          `json:"rpcId"`
			Method  string          `json:"method"`
			Payload json.RawMessage `json:"payload"`
		}
		if err := json.NewDecoder(r.Body).Decode(&env); err != nil {
			t.Fatalf("decode envelope: %v", err)
		}
		if env.Type != "client-request" || env.RPCID == "" {
			t.Fatalf("信封形状错误: %+v", env)
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/session.create"):
			fmt.Fprintf(w, `{"type":"server-response","rpcId":%q,"result":{"ok":true,"value":{"sessionId":"s-1","agentPreset":"standard"}}}`, env.RPCID)
		case strings.HasSuffix(r.URL.Path, "/session.prompt"):
			fmt.Fprintf(w, `{"type":"server-response","rpcId":%q,"result":{"ok":true,"value":{"accepted":true}}}`, env.RPCID)
		case strings.HasSuffix(r.URL.Path, "/session.history"):
			fmt.Fprintf(w, `{"type":"server-response","rpcId":%q,"result":{"ok":true,"value":{"events":[]}}}`, env.RPCID)
		case strings.HasSuffix(r.URL.Path, "/llm.providers"):
			fmt.Fprintf(w, `{"type":"server-response","rpcId":%q,"result":{"ok":true,"value":{}}}`, env.RPCID)
		default:
			fmt.Fprintf(w, `{"type":"server-response","rpcId":%q,"result":{"ok":false,"error":{"code":"unknown","message":"no"}}}`, env.RPCID)
		}
	}))
	defer srv.Close()

	api := newDSHAPI(dshHostAddr{baseURL: srv.URL})
	ctx := context.Background()

	created, err := api.createSession(ctx, "/tmp/x", "", "standard")
	if err != nil || created.SessionID != "s-1" {
		t.Fatalf("createSession: %v %+v", err, created)
	}
	if err := api.prompt(ctx, "s-1", "queue", []map[string]any{{"type": "text", "text": "hi"}}); err != nil {
		t.Fatalf("prompt: %v", err)
	}
	if _, err := api.history(ctx, "s-1", 0, 10); err != nil {
		t.Fatalf("history: %v", err)
	}
	// 未知方法 → 错误分支
	if _, err := api.call(ctx, "session.nope", map[string]any{}); err == nil || !strings.Contains(err.Error(), "no") {
		t.Fatalf("未知方法应返回宿主错误，得到 %v", err)
	}
	if len(calls) != 4 {
		t.Fatalf("应调用 4 个方法，得到 %v", calls)
	}
}

// 事件归一化：dsh 事件 → pi 形状 rpcEvent。
func TestNormalizeDSHEvent(t *testing.T) {
	cases := []struct {
		name string
		in   dshEvent
		want rpcEvent
	}{
		{"turn/start", dshEvent{Type: "turn/start"}, rpcEvent{Type: "turn_start"}},
		{"step/start（订阅窗口外无 turn/start 时）", dshEvent{Type: "step/start"}, rpcEvent{Type: "turn_start"}},
		{"turn/end", dshEvent{Type: "turn/end", Time: 1700000000123}, rpcEvent{Type: "message_end", Message: json.RawMessage(`{"timestamp":1700000000123}`)}},
		{"user/message", dshEvent{Type: "user/message", Data: json.RawMessage(`{"content":[]}`)}, rpcEvent{Type: "user_echo", Message: json.RawMessage(`{"content":[]}`)}},
		{"ignored", dshEvent{Type: "tool/result"}, rpcEvent{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := normalizeDSHEvent(tc.in)
			if got.Type != tc.want.Type || !jsonEqual(got.Message, tc.want.Message) {
				t.Fatalf("normalize(%s) = %+v，期望 %+v", tc.in.Type, got, tc.want)
			}
		})
	}

	// 流式块：text/text/reasoning/tool-call
	check := func(raw string, wantType, wantDelta string) {
		t.Helper()
		got := normalizeChunkEvent(json.RawMessage(`{"chunk":` + raw + `}`))
		if got.Type != "message_update" {
			t.Fatalf("chunk %s 应翻译为 message_update: %+v", raw, got)
		}
		var ame map[string]any
		if err := json.Unmarshal(got.AssistantMessageEvent, &ame); err != nil {
			t.Fatal(err)
		}
		if ame["type"] != wantType {
			t.Fatalf("chunk %s 类型应=%s，得到 %v", raw, wantType, ame["type"])
		}
		if wantDelta != "" && ame["delta"] != wantDelta {
			t.Fatalf("chunk %s delta 应=%s，得到 %v", raw, wantDelta, ame["delta"])
		}
	}
	check(`{"type":"block-start","index":0,"blockType":"reasoning"}`, "thinking_start", "")
	check(`{"type":"reasoning-delta","index":0,"text":"想"}`, "thinking_delta", "想")
	check(`{"type":"text-delta","index":1,"text":"你好"}`, "text_delta", "你好")
	check(`{"type":"tool-call-delta","index":2,"id":"c1","name":"bash","argumentsDelta":""}`, "toolcall_start", "")
	tool := normalizeChunkEvent(json.RawMessage(`{"chunk":{"type":"tool-call-delta","index":2,"argumentsDelta":"{}"}}`))
	var ameTool map[string]any
	_ = json.Unmarshal(tool.AssistantMessageEvent, &ameTool)
	if ameTool["type"] != "toolcall_delta" || ameTool["delta"] != "{}" {
		t.Fatalf("后续工具增量应 toolcall_delta: %v", ameTool)
	}
	check(`{"type":"block-end","index":1,"block":{"type":"text","text":"写好了"}}`, "text_end", "")
}

func jsonEqual(a, b json.RawMessage) bool {
	if len(a) == 0 && len(b) == 0 {
		return true
	}
	return string(a) == string(b)
}

// 转录归一化：user/assistant/think/工具/压缩各自成为独立条目。
func TestBuildDshTranscriptEntries(t *testing.T) {
	event := func(typ string, seq int64, data string) json.RawMessage {
		raw, _ := json.Marshal(map[string]any{
			"type": typ, "seq": seq, "time": 1700000000000 + seq,
			"data": json.RawMessage(data),
		})
		return raw
	}
	events := []json.RawMessage{
		event("permission/preset", 0, `{"preset":"danger-full-access"}`),
		event("user/message", 1, `{"content":[{"type":"text","text":"帮我看看"}],"id":"u1"}`),
		event("turn/start", 2, `{"turn":1}`),
		event("assistant/message", 3, `{"message":{"content":[{"type":"text","text":"好的"},{"type":"reasoning","text":"先看代码"}]}}`),
		event("tool/call", 4, `{"callId":"c1","name":"glob","arguments":"{\"pattern\":\"*.go\"}"}`),
		event("tool/result", 5, `{"message":{"content":[{"type":"tool-result","toolCallId":"c1","content":[{"type":"text","text":"a.go b.go"}]}]}}`),
		event("assistant/message", 6, `{"message":{"content":[{"type":"text","text":"找到了"}]}}`),
		event("turn/end", 7, `{"turn":1,"reason":{"kind":"completed"}}`),
		event("compaction/summary", 8, `{"summary":"压缩了"}`),
	}

	entries := buildDshTranscriptEntries(events)
	if len(entries) != 6 {
		t.Fatalf("期望 6 条 entry（user + text + thinking + glob + text + compaction），得到 %d: %+v", len(entries), entries)
	}
	user := entries[0]
	um := user["message"].(map[string]any)
	if um["role"] != "user" || um["id"] != "u1" {
		t.Fatalf("user entry 形状错误: %+v", user)
	}
	asst1 := entries[1]["message"].(map[string]any)
	if asst1["role"] != "assistant" {
		t.Fatalf("assistant entry: %+v", entries[1])
	}
	content1 := asst1["content"].([]map[string]any)
	if len(content1) != 1 || content1[0]["text"] != "好的" {
		t.Fatalf("第一段助手文本应为独立条目: %+v", entries[1])
	}
	think := entries[2]
	if think["type"] != "custom_message" || think["customType"] != "thinking" || think["content"] != "先看代码" {
		t.Fatalf("thinking 应为独立条目: %+v", think)
	}
	tool := entries[3]
	if tool["type"] != "custom_message" || tool["customType"] != "glob" || tool["content"] != "a.go b.go" {
		t.Fatalf("glob 工具应为独立条目: %+v", tool)
	}
	asst2 := entries[4]["message"].(map[string]any)
	if asst2["role"] != "assistant" {
		t.Fatalf("第二段助手文本应为独立条目: %+v", entries[4])
	}
	if entries[5]["customType"] != "compaction" {
		t.Fatalf("压缩事件: %+v", entries[5])
	}
}

// 转录归一化：bash 工具应转成独立的 bashExecution 条目。
func TestBuildDshTranscriptEntriesBash(t *testing.T) {
	event := func(typ string, seq int64, data string) json.RawMessage {
		raw, _ := json.Marshal(map[string]any{
			"type": typ, "seq": seq, "time": 1700000000000 + seq,
			"data": json.RawMessage(data),
		})
		return raw
	}
	events := []json.RawMessage{
		event("user/message", 1, `{"content":[{"type":"text","text":"跑一下"}],"id":"u1"}`),
		event("assistant/message", 2, `{"message":{"content":[{"type":"text","text":"马上"}]}}`),
		event("tool/call", 3, `{"callId":"b1","name":"bash","arguments":"{\"command\":\"ls -la\"}"}`),
		event("tool/result", 4, `{"message":{"content":[{"type":"tool-result","toolCallId":"b1","isError":false,"content":[{"type":"text","text":"total 0"}]}]}}`),
		event("turn/end", 5, `{}`),
	}

	entries := buildDshTranscriptEntries(events)
	if len(entries) != 3 {
		t.Fatalf("期望 3 条 entry（user + assistant + bash），得到 %d: %+v", len(entries), entries)
	}
	bash := entries[2]
	bm := bash["message"].(map[string]any)
	if bm["role"] != "bashExecution" || bm["command"] != "ls -la" || bm["output"] != "total 0" {
		t.Fatalf("bash 条目形状错误: %+v", bash)
	}
	if bm["isError"] != false {
		t.Fatalf("bash isError 应为 false: %+v", bash)
	}
}

// dshChannel 命令路由：prompt/abort 映射到 HTTP 方法。
func TestDSHChannelCommands(t *testing.T) {
	var methods atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		methods.Add(1)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/session.create"):
			fmt.Fprint(w, `{"type":"server-response","rpcId":"1","result":{"ok":true,"value":{"sessionId":"s-9"}}}`)
		case strings.HasSuffix(r.URL.Path, "/session.prompt"):
			var env struct {
				Payload struct {
					Mode    string `json:"mode"`
					Content []struct {
						Type string `json:"type"`
						Text string `json:"text"`
					} `json:"content"`
				} `json:"payload"`
			}
			_ = json.NewDecoder(r.Body).Decode(&env)
			if env.Payload.Mode != "queue" || env.Payload.Content[0].Text != "你好" {
				t.Fatalf("prompt payload 错误: %+v", env.Payload)
			}
			fmt.Fprint(w, `{"type":"server-response","rpcId":"2","result":{"ok":true,"value":{"accepted":true}}}`)
		case strings.HasSuffix(r.URL.Path, "/session.cancel"):
			fmt.Fprint(w, `{"type":"server-response","rpcId":"3","result":{"ok":true,"value":{}}}`)
		default:
			t.Fatalf("意外方法: %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	ch, err := newDSHChannel(1, dshHostAddr{baseURL: srv.URL}, dshPermFull, "/tmp/x", "standard", "")
	if err != nil {
		t.Fatal(err)
	}
	if ch.dshSession != "s-9" {
		t.Fatalf("dshSession=%q", ch.dshSession)
	}
	if resp, err := ch.runCommand(context.Background(), "prompt", map[string]any{"message": "你好"}, time.Second); err != nil || !resp.Success {
		t.Fatalf("prompt: %v %+v", err, resp)
	}
	if resp, err := ch.runCommand(context.Background(), "abort", nil, time.Second); err != nil || !resp.Success {
		t.Fatalf("abort: %v %+v", err, resp)
	}
	// 未知命令拒绝
	if _, err := ch.runCommand(context.Background(), "get_state", nil, time.Second); err == nil {
		t.Fatal("get_state 应被 dsh 通道拒绝")
	}
	if methods.Load() != 3 {
		t.Fatalf("HTTP 调用次数 = %d", methods.Load())
	}
}

func TestDshPermOf(t *testing.T) {
	if dshPermOf("full") != dshPermFull || dshPermOf("review") != dshPermReview || dshPermOf("") != dshPermReview {
		t.Fatal("perm 路由归一化错误")
	}
}

// 会话 id sidecar 持久化（恢复/交付后读取）。
func TestDSHSessionIDSidecar(t *testing.T) {
	dir := t.TempDir()
	if got := readDSHSessionID(dir); got != "" {
		t.Fatalf("空目录应返回空 id: %q", got)
	}
	persistDSHSessionID(dir, "session-abc")
	if got := readDSHSessionID(dir); got != "session-abc" {
		t.Fatalf("sidecar 读写失败: %q", got)
	}
}

func TestDSHPromptMode(t *testing.T) {
	if dshPromptMode("steer") != "steer" || dshPromptMode("follow_up") != "queue" || dshPromptMode(nil) != "queue" {
		t.Fatal("streamingBehavior 映射错误")
	}
}

// TestDSHHostEndToEnd 走真实 dsh 宿主完整会话链路：建会话通道（含 SSE 订阅）
// → prompt → 实时事件归一化 + history 转录归一化 → cancel。需要本机装有 dsh
// 且配置了凭据；用 PAIHUO_DSH_E2E=1 开启（常跑测试默认跳过）。
func TestDSHHostEndToEnd(t *testing.T) {
	if os.Getenv("PAIHUO_DSH_E2E") != "1" {
		t.Skip("PAIHUO_DSH_E2E=1 时运行真实 dsh 宿主链路")
	}
	if _, err := osexec.LookPath("dsh"); err != nil {
		t.Skip("dsh 未安装")
	}
	pool := newDSHHostPool(t.TempDir())
	t.Cleanup(pool.StopAll)
	ctx := context.Background()
	addr, err := pool.addr(ctx, dshPermFull)
	if err != nil {
		t.Fatalf("dsh 宿主启动失败: %v", err)
	}
	// 完整通道：创建会话 + 订阅 SSE + 实时事件翻译。
	ch, err := newDSHChannel(1, addr, dshPermFull, t.TempDir(), "standard", "")
	if err != nil {
		t.Fatalf("newDSHChannel: %v", err)
	}
	var liveMu sync.Mutex
	var liveTypes []string
	settled := make(chan struct{})
	ch.setEventHandler(func(ev rpcEvent) {
		liveMu.Lock()
		liveTypes = append(liveTypes, ev.Type)
		done := ev.Type == "message_end"
		liveMu.Unlock()
		if done {
			select {
			case settled <- struct{}{}:
			default:
			}
		}
	})
	ch.start()
	defer ch.terminate()

	if resp, err := ch.runCommand(ctx, "prompt", map[string]any{"message": "只回复两个字：收到"}, time.Second); err != nil || !resp.Success {
		t.Fatalf("prompt: %v %+v", err, resp)
	}
	// 实时事件应出现流式增量与回合结束（LLM 调用通常 5-30s）。
	select {
	case <-settled:
	case <-time.After(120 * time.Second):
		liveMu.Lock()
		got := strings.Join(liveTypes, ",")
		liveMu.Unlock()
		t.Fatalf("未收到回合结束事件（收到: %s）", got)
	}
	liveMu.Lock()
	joined := strings.Join(liveTypes, ",")
	liveMu.Unlock()
	if !strings.Contains(joined, "turn_start") || !strings.Contains(joined, "message_update") {
		t.Fatalf("实时事件缺少 turn_start/message_update: %s", joined)
	}

	// 转录归一化：user + assistant（文本块）消息。
	api := newDSHAPI(addr)
	events, err := api.history(ctx, ch.dshSession, 0, 0)
	if err != nil {
		t.Fatalf("history: %v", err)
	}
	entries := buildDshTranscriptEntries(events)
	if len(entries) < 2 {
		t.Fatalf("转录应含 user+assistant 消息，得到 %d 条", len(entries))
	}
	if um := entries[0]["message"].(map[string]any); um["role"] != "user" {
		t.Fatalf("第一条应为用户消息: %+v", entries[0])
	}
	if resp, err := ch.runCommand(ctx, "abort", nil, time.Second); err != nil || !resp.Success {
		t.Fatalf("cancel: %v %+v", err, resp)
	}
}

// 帧归一化：审批/提问帧 → extension_ui_request，应答回显 rpcId。
func TestNormalizeDSHFrameInteractions(t *testing.T) {
	ch := &dshChannel{
		exited:           make(chan struct{}),
		pendingApprovals: make(map[string]string),
		pendingQuestions: make(map[string]dshQuestionTarget),
	}
	// 审批帧
	ev := normalizeDSHFrame(dshFrame{
		Method: "approval/requested", RPCID: "rpc-1",
		Payload: json.RawMessage(`{"sessionId":"s-1","approvalId":"ap-1","toolName":"bash","reason":"要执行 rm"}`),
	}, ch)
	if ev == nil || ev.Type != "extension_ui_request" || ev.Method != "confirm" || ev.ID != "rpc-1" {
		t.Fatalf("审批帧翻译错误: %+v", ev)
	}
	if ch.pendingApprovals["rpc-1"] != "ap-1" {
		t.Fatalf("审批帧未登记: %v", ch.pendingApprovals)
	}
	// 提问帧（带选项）
	qev := normalizeDSHFrame(dshFrame{
		Method: "question/requested", RPCID: "rpc-2",
		Payload: json.RawMessage(`{"sessionId":"s-1","questions":[{"id":"q1","question":"选哪个？","options":[{"label":"A"},{"label":"B"}]}]}`),
	}, ch)
	if qev == nil || qev.Method != "select" || len(qev.Options) != 2 {
		t.Fatalf("提问帧翻译错误: %+v", qev)
	}
	if ch.pendingQuestions["rpc-2"].questionID != "q1" {
		t.Fatalf("提问帧未登记: %v", ch.pendingQuestions)
	}
	// resolved 清理
	normalizeDSHFrame(dshFrame{Method: "approval/resolved", RPCID: "rpc-1"}, ch)
	if _, ok := ch.pendingApprovals["rpc-1"]; ok {
		t.Fatal("resolved 后审批帧应清理")
	}
	normalizeDSHFrame(dshFrame{Method: "question/resolved", RPCID: "rpc-2"}, ch)
	if _, ok := ch.pendingQuestions["rpc-2"]; ok {
		t.Fatal("resolved 后提问帧应清理")
	}
}

// 应答路由：approval → respond(outcome)；question → respond(answer)。
func TestDSHChannelRespond(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/respond" {
			t.Fatalf("意外路径: %s", r.URL.Path)
		}
		b, _ := io.ReadAll(r.Body)
		got = string(b)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"accepted":true}`)
	}))
	defer srv.Close()
	ch := &dshChannel{
		api: newDSHAPI(dshHostAddr{baseURL: srv.URL}), dshSession: "s-1",
		exited:           make(chan struct{}),
		pendingApprovals: map[string]string{"rpc-1": "ap-1"},
		pendingQuestions: map[string]dshQuestionTarget{"rpc-2": {rpcID: "rpc-2", questionID: "q1"}},
	}
	if err := ch.sendLine(map[string]any{"id": "rpc-1", "confirmed": true}); err != nil {
		t.Fatalf("审批应答: %v", err)
	}
	if !strings.Contains(got, `"approvalId":"ap-1"`) || !strings.Contains(got, `"outcome":"allowed-once"`) {
		t.Fatalf("审批应答载荷错误: %s", got)
	}
	if err := ch.sendLine(map[string]any{"id": "rpc-2", "value": "A"}); err != nil {
		t.Fatalf("提问应答: %v", err)
	}
	if !strings.Contains(got, `"selected":["A"]`) || !strings.Contains(got, `"id":"q1"`) {
		t.Fatalf("提问应答载荷错误: %s", got)
	}
}
