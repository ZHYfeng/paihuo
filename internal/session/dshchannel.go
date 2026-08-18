// dshchannel：DeepSeek Harness 会话的执行通道。
//
// 与 rpcProc（pi --mode rpc 子进程）平级的通道实现：每个 dsh 会话不是独立
// 子进程，而是 dsh web 宿主（dshhost.go）内的一个持久会话 + 一条 SSE 订阅。
// 会话挂起 = 断订阅（宿主侧会话继续持久化）；恢复 = session.create{sessionId}
// 原样接回。事件经 normalizeDSHEvent 翻译成现有 rpcEvent 形状，Manager 与
// 前端（pi 事件模型）无需为 dsh 分支。
package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// dshSessionIDFile 是会话目录里记录 dsh 侧会话 id 的 sidecar 文件名。
// 挂起/交付后仍可据此恢复或读取历史。
const dshSessionIDFile = "dsh-session-id"

// dshChannel 实现 sessionChannel（Manager 的会话通道抽象）。
type dshChannel struct {
	sessionID   int64 // paihuo 会话 id
	perm        dshPerm
	agentPreset string
	cwd         string
	hostAddr    dshHostAddr
	api         *dshAPI

	dshSession string // dsh 侧会话 id（create 返回）
	streamCtx  context.Context
	cancel     context.CancelFunc

	mu        sync.Mutex
	exited    chan struct{}
	exitOnce  sync.Once
	closed    bool // 主动关闭（挂起/交付），不触发 onExit
	lastEvent time.Time
	onEvent   func(rpcEvent)
	onExit    func()
	// 挂起的宿主交互帧：应答（sendLine→respond）时按 askID 找回回显信息。
	pendingApprovals map[string]string            // askID(=帧 rpcId) → approvalId
	pendingQuestions map[string]dshQuestionTarget // askID → 提问帧目标
}

// dshQuestionTarget 记录一个提问帧的回显信息（respond 回显帧 rpcId）。
type dshQuestionTarget struct {
	rpcID      string
	questionID string
}

// newDSHChannel 在给定宿主上创建/恢复 dsh 会话并返回通道。
// resume 非空时原样恢复该 dsh 会话；cwd 与 agentPreset 只在新建时生效。
func newDSHChannel(sessionID int64, addr dshHostAddr, perm dshPerm, cwd, agentPreset, resume string) (*dshChannel, error) {
	ctx, cancel := context.WithCancel(context.Background())
	ch := &dshChannel{
		sessionID:        sessionID,
		perm:             perm,
		agentPreset:      agentPreset,
		cwd:              cwd,
		hostAddr:         addr,
		api:              newDSHAPI(addr),
		streamCtx:        ctx,
		cancel:           cancel,
		exited:           make(chan struct{}),
		lastEvent:        time.Now(),
		pendingApprovals: make(map[string]string),
		pendingQuestions: make(map[string]dshQuestionTarget),
	}
	created, err := ch.api.createSession(ctx, cwd, resume, agentPreset)
	if err != nil {
		cancel()
		return nil, err
	}
	ch.dshSession = created.SessionID
	return ch, nil
}

// start 开订阅事件流（进程生命独立于请求 ctx）。
func (c *dshChannel) start() {
	onFrame := func(frame dshFrame) {
		c.mu.Lock()
		c.lastEvent = time.Now()
		c.mu.Unlock()
		if ev := normalizeDSHFrame(frame, c); ev != nil {
			c.mu.Lock()
			cb := c.onEvent
			c.mu.Unlock()
			if cb != nil {
				cb(*ev)
			}
		}
	}
	go func() {
		err := c.api.eventStream(c.streamCtx, c.dshSession, onFrame)
		c.exitOnce.Do(func() {
			c.mu.Lock()
			closed := c.closed
			cb := c.onExit
			c.mu.Unlock()
			if !closed && err != nil && cb != nil {
				// 非主动关闭的流中断：宿主进程退出/网络故障 → 会话按崩溃处理。
				cb()
			}
			close(c.exited)
		})
	}()
}

// dshSessionIDPath 返回会话目录下的 dsh session id sidecar 路径。
func dshSessionIDPath(sessionDir string) string {
	return filepath.Join(sessionDir, dshSessionIDFile)
}

// persistDSHSessionID 把 dsh 侧会话 id 落盘（恢复/交付后读取）。
func persistDSHSessionID(sessionDir, id string) {
	if sessionDir == "" {
		return
	}
	_ = os.MkdirAll(sessionDir, 0o755)
	_ = os.WriteFile(dshSessionIDPath(sessionDir), []byte(id), 0o644)
}

// readDSHSessionID 读取上次记录的 dsh 会话 id（空串表示从未创建）。
func readDSHSessionID(sessionDir string) string {
	b, err := os.ReadFile(dshSessionIDPath(sessionDir))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// ---------------------------------------------------------------------------
// sessionChannel 接口实现

func (c *dshChannel) runCommand(ctx context.Context, cmdType string, fields map[string]any, timeout time.Duration) (rpcResponse, error) {
	if c.dshSession == "" {
		return rpcResponse{ID: cmdType, Success: false}, errors.New("dsh 会话未建立")
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var err error
	switch cmdType {
	case "prompt":
		msg, _ := fields["message"].(string)
		mode := dshPromptMode(fields["streamingBehavior"])
		content := []map[string]any{{"type": "text", "text": msg}}
		// 图片附件（pi 形状 {mimeType, data}）→ dsh image 内容块。
		if imgs, ok := fields["images"].([]map[string]any); ok {
			for _, img := range imgs {
				if _, present := img["data"]; !present {
					continue
				}
				mediaType, _ := img["mimeType"].(string)
				if mediaType == "" {
					mediaType = "image/png"
				}
				content = append(content, map[string]any{
					"type": "image", "mediaType": mediaType, "data": img["data"],
				})
			}
		}
		err = c.api.prompt(ctx, c.dshSession, mode, content)
	case "abort":
		err = c.api.cancel(ctx, c.dshSession)
	case "switch_session":
		// HTTP 通道在 create 时已恢复目标会话；此命令仅 pi RPC 路径需要。
		return rpcResponse{ID: cmdType, Success: true}, nil
	case "compact":
		// dsh 的压缩走 prompt 的斜杠命令槽（/compact）。
		err = c.api.prompt(ctx, c.dshSession, "queue", []map[string]any{{"type": "text", "text": "/compact"}})
	case "set_model":
		err = c.api.selectModel(ctx, c.dshSession,
			stringField(fields, "provider"), stringField(fields, "model"), stringField(fields, "effort"))
	case "rename":
		err = c.api.rename(ctx, c.dshSession, stringField(fields, "title"))
	default:
		return rpcResponse{ID: cmdType, Success: false}, fmt.Errorf("未知会话命令: %s", cmdType)
	}
	if err != nil {
		return rpcResponse{ID: cmdType, Success: false, Error: err.Error()}, err
	}
	return rpcResponse{ID: cmdType, Success: true}, nil
}

func stringField(fields map[string]any, key string) string {
	v, _ := fields[key].(string)
	return v
}

// dshPromptMode 把 pi 的 streamingBehavior 映射为 dsh prompt 的 mode：
// steer=立即插入；其余（follow_up/空）排队等当前回合结束。
func dshPromptMode(streamingBehavior any) string {
	if v, ok := streamingBehavior.(string); ok && v == "steer" {
		return "steer"
	}
	return "queue"
}

// sendLine：dsh 通道无 stdin 概念；审批/提问应答走 POST /api/respond
// （client-response 回显挂起帧的 rpcId）。字段来自 Manager.AnswerAsk
// （{type:"extension_ui_response", id, value, confirmed, cancelled}）。
func (c *dshChannel) sendLine(cmd map[string]any) error {
	askID, _ := cmd["id"].(string)
	if askID == "" {
		return errors.New("应答 id 不能为空")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	confirmed, hasConfirmed := cmd["confirmed"].(bool)
	cancelled, _ := cmd["cancelled"].(bool)
	value, _ := cmd["value"].(string)

	c.mu.Lock()
	approvalID, isApproval := c.pendingApprovals[askID]
	target, isQuestion := c.pendingQuestions[askID]
	c.mu.Unlock()

	switch {
	case isApproval:
		outcome := "rejected"
		if hasConfirmed && confirmed {
			outcome = "allowed-once"
		}
		return c.api.respond(ctx, askID, map[string]any{
			"sessionId": c.dshSession, "approvalId": approvalID, "outcome": outcome,
		})
	case isQuestion:
		var selected []string
		custom := ""
		if !cancelled && value != "" {
			selected = []string{value}
		}
		answer := map[string]any{
			"answers": []map[string]any{{"id": target.questionID, "selected": selected, "custom": custom}},
		}
		return c.api.respond(ctx, target.rpcID, map[string]any{
			"sessionId": c.dshSession, "answer": answer,
		})
	default:
		return fmt.Errorf("未知的应答目标: %s", askID)
	}
}

// terminate 断开会话订阅（挂起/交付/服务退出）。不杀宿主进程——会话在
// 宿主侧持久化，恢复时 session.create{sessionId} 原样接回。
func (c *dshChannel) terminate() {
	c.mu.Lock()
	c.closed = true
	c.mu.Unlock()
	c.cancel()
}

func (c *dshChannel) setEventHandler(fn func(rpcEvent)) {
	c.mu.Lock()
	c.onEvent = fn
	c.mu.Unlock()
}

func (c *dshChannel) setExitHandler(fn func()) {
	c.mu.Lock()
	c.onExit = fn
	c.mu.Unlock()
}

func (c *dshChannel) lastEventTime() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lastEvent
}

// ---------------------------------------------------------------------------
// 转录归一化：dsh 会话事件流 → pi 形状的 transcript entries。

// buildDshTranscriptEntries 把 session.history 的事件列表翻译成前端已有的
// pi transcript entry 形状（buildRenderItems 直接消费）：
//   - user/message → role=user 消息
//   - assistant/message → role=assistant（同一回合的多次分段合并为一条，
//     块含 text/thinking；tool/call 转 toolCall 块，tool/result 聚合到
//     msg.toolResults，前端按 callId 配对渲染工具卡片）
//   - tool/call、tool/result → 并入所属的助手消息
//   - compaction/summary → 压缩事件
//
// entry.id 采用 dsh 的 seq（分页游标：beforeSeq）。
func buildDshTranscriptEntries(events []json.RawMessage) []map[string]any {
	type dshMsg struct {
		Type string          `json:"type"`
		Seq  int64           `json:"seq"`
		Time int64           `json:"time"`
		Data json.RawMessage `json:"data"`
	}
	var out []map[string]any
	var cur map[string]any // 当前助手消息（回合内累积）

	finishAssistant := func() {
		if cur == nil {
			return
		}
		ts, _ := cur["timestamp"].(string)
		content, _ := cur["content"].([]map[string]any)
		results, _ := cur["toolResults"].(map[string]any)
		seq, _ := cur["seq"].(int64)
		out = append(out, map[string]any{
			"type": "message", "id": fmt.Sprintf("%d", seq),
			"message": map[string]any{
				"role": "assistant", "content": content, "timestamp": ts, "toolResults": results,
			},
		})
		cur = nil
	}
	ensureCur := func(seq int64, ts string) {
		if cur == nil {
			cur = map[string]any{"seq": seq, "timestamp": ts, "content": []map[string]any{}, "toolResults": map[string]any{}}
		}
	}
	appendTextOrReasoning := func(block map[string]any) {
		bt, _ := block["type"].(string)
		switch bt {
		case "text":
			cur["content"] = append(cur["content"].([]map[string]any), block)
		case "reasoning":
			cur["content"] = append(cur["content"].([]map[string]any),
				map[string]any{"type": "thinking", "thinking": block["text"]})
		}
	}

	for _, raw := range events {
		var e dshMsg
		// history 的每个元素是 {"event": {...}} 包装，解包后再解析。
		var wrapped struct {
			Event json.RawMessage `json:"event"`
		}
		if json.Unmarshal(raw, &wrapped) == nil && len(wrapped.Event) > 0 {
			raw = wrapped.Event
		}
		if err := json.Unmarshal(raw, &e); err != nil || e.Type == "" {
			continue
		}
		ts := time.UnixMilli(e.Time).UTC().Format(time.RFC3339)
		switch e.Type {
		case "user/message":
			finishAssistant()
			var data struct {
				Content []map[string]any `json:"content"`
				ID      string           `json:"id"`
			}
			_ = json.Unmarshal(e.Data, &data)
			out = append(out, map[string]any{
				"type": "message", "id": fmt.Sprintf("%d", e.Seq),
				"message": map[string]any{"role": "user", "content": data.Content, "id": data.ID, "timestamp": ts},
			})
		case "assistant/message":
			ensureCur(e.Seq, ts)
			var data struct {
				Message struct {
					Content []map[string]any `json:"content"`
				} `json:"message"`
			}
			_ = json.Unmarshal(e.Data, &data)
			for _, block := range data.Message.Content {
				appendTextOrReasoning(block)
			}
		case "tool/call":
			ensureCur(e.Seq, "")
			var data struct {
				CallID    string `json:"callId"`
				Name      string `json:"name"`
				Arguments string `json:"arguments"`
			}
			_ = json.Unmarshal(e.Data, &data)
			var args any = data.Arguments
			if len(data.Arguments) > 0 {
				var parsed any
				if err := json.Unmarshal([]byte(data.Arguments), &parsed); err == nil {
					args = parsed
				}
			}
			cur["content"] = append(cur["content"].([]map[string]any),
				map[string]any{"type": "toolCall", "id": data.CallID, "name": data.Name, "arguments": args})
		case "tool/result":
			if cur == nil {
				continue
			}
			var data struct {
				Message struct {
					Content []map[string]any `json:"content"`
				} `json:"message"`
			}
			_ = json.Unmarshal(e.Data, &data)
			var callID string
			var resultText []map[string]any
			var isErr bool
			for _, block := range data.Message.Content {
				bt, _ := block["type"].(string)
				if bt != "tool-result" {
					continue
				}
				callID, _ = block["toolCallId"].(string)
				if es, ok := block["isError"].(bool); ok {
					isErr = es
				}
				if inner, ok := block["content"].([]any); ok {
					for _, c := range inner {
						if m, ok := c.(map[string]any); ok {
							resultText = append(resultText, map[string]any{"type": "text", "text": m["text"]})
						} else {
							resultText = append(resultText, map[string]any{"type": "text", "text": fmt.Sprint(c)})
						}
					}
				} else if inner, ok := block["content"].([]map[string]any); ok {
					resultText = append(resultText, inner...)
				}
			}
			if callID == "" {
				continue
			}
			results := cur["toolResults"].(map[string]any)
			results[callID] = map[string]any{"content": resultText, "isError": isErr}
		case "turn/end":
			finishAssistant()
		case "compaction/summary":
			var data struct {
				Summary string `json:"summary"`
			}
			_ = json.Unmarshal(e.Data, &data)
			out = append(out, map[string]any{
				"type": "custom", "id": fmt.Sprintf("%d", e.Seq),
				"customType": "compaction", "content": "上下文已压缩", "summary": data.Summary,
			})
			finishAssistant()
		}
	}
	finishAssistant()
	return out
}

// ---------------------------------------------------------------------------
// 事件归一化：dsh 会话事件 → pi 形状的 rpcEvent（前端零改动）。

// normalizeDSHFrame 把 mux 帧翻译成前端认识的 rpcEvent：
//   - session/event：内嵌会话事件 → normalizeDSHEvent
//   - approval/requested：审批请求 → extension_ui_request（confirm）
//   - question/requested：交互提问 → extension_ui_request（select/input）
//
// 同时把挂起帧登记进通道，应答时（sendLine→respond）按 askID 找回回显信息。
func normalizeDSHFrame(frame dshFrame, ch *dshChannel) *rpcEvent {
	type questionItem struct {
		ID       string `json:"id"`
		Question string `json:"question"`
		Header   string `json:"header"`
		Detail   string `json:"detail"`
		Options  []struct {
			Label string `json:"label"`
		} `json:"options"`
	}
	switch frame.Method {
	case "session/event":
		var wrapper struct {
			Event dshEvent `json:"event"`
		}
		if err := json.Unmarshal(frame.Payload, &wrapper); err != nil || wrapper.Event.Type == "" {
			return nil
		}
		ev := normalizeDSHEvent(wrapper.Event)
		if ev.Type == "" {
			return nil
		}
		return &ev
	case "approval/requested":
		var data struct {
			ApprovalID string `json:"approvalId"`
			ToolName   string `json:"toolName"`
			Reason     string `json:"reason"`
		}
		if err := json.Unmarshal(frame.Payload, &data); err != nil || data.ApprovalID == "" {
			return nil
		}
		ch.mu.Lock()
		ch.pendingApprovals[frame.RPCID] = data.ApprovalID
		ch.mu.Unlock()
		return &rpcEvent{
			Type: "extension_ui_request", Method: "confirm", ID: frame.RPCID,
			Title:   "工具审批 · " + data.ToolName,
			Message: []byte(jsonString(data.Reason)),
		}
	case "question/requested":
		var data struct {
			Questions []questionItem `json:"questions"`
		}
		if err := json.Unmarshal(frame.Payload, &data); err != nil || len(data.Questions) == 0 {
			return nil
		}
		// dsh 一次帧可能挂起多个问题；逐问题登记，首问题立即投递，
		// 其余问题的交互形态在首个问题应答后由后续帧重新呈现。
		for i, q := range data.Questions {
			askID := frame.RPCID
			if len(data.Questions) > 1 {
				askID = frame.RPCID + "#" + q.ID
			}
			ch.mu.Lock()
			ch.pendingQuestions[askID] = dshQuestionTarget{rpcID: frame.RPCID, questionID: q.ID}
			ch.mu.Unlock()
			if i != 0 {
				continue
			}
			method := "input"
			if len(q.Options) > 0 {
				method = "select"
			}
			options := make([]string, 0, len(q.Options))
			for _, o := range q.Options {
				options = append(options, o.Label)
			}
			return &rpcEvent{
				Type: "extension_ui_request", Method: method, ID: askID,
				Title: q.Question, Options: options, Message: []byte(jsonString(q.Detail)),
			}
		}
		return nil
	case "approval/resolved":
		ch.mu.Lock()
		delete(ch.pendingApprovals, frame.RPCID)
		ch.mu.Unlock()
		return nil
	case "question/resolved":
		ch.mu.Lock()
		for askID := range ch.pendingQuestions {
			if ch.pendingQuestions[askID].rpcID == frame.RPCID {
				delete(ch.pendingQuestions, askID)
			}
		}
		ch.mu.Unlock()
		return nil
	default:
		return nil
	}
}

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// normalizeDSHEvent 把 dsh 事件翻译成 Manager/前端认识的 rpcEvent。
// 流式增量对齐前端 applyStreamDelta 的块协议
// （thinking_start/_delta/_end、text_start/_delta/_end、toolcall_start/_delta）。
func normalizeDSHEvent(ev dshEvent) rpcEvent {
	switch ev.Type {
	case "turn/start", "step/start":
		// 回合开始信号：dsh 的 turn/start 可能落在订阅窗口之外（部分会话
		// 只有 step/start），两者都映射为 turn_start 驱动前端 running 状态。
		return rpcEvent{Type: "turn_start"}
	case "turn/end":
		// message_end 驱动前端清 liveMsg + 刷新 transcript；timestamp 供
		// Manager 更新 last_message_at。
		return rpcEvent{Type: "message_end", Message: []byte(fmt.Sprintf(`{"timestamp":%d}`, ev.Time))}
	case "user/message":
		return rpcEvent{Type: "user_echo", Message: ev.Data}
	case "assistant/chunk":
		return normalizeChunkEvent(ev.Data)
	default:
		// 其余（tool/call、tool/result、session/title、agent/* 等）不实时投递，
		// 由 transcript 轮询补齐。
		return rpcEvent{}
	}
}

// dshChunkPart 是 assistant/chunk 的 chunk 字段。
type dshChunkPart struct {
	Type      string `json:"type"`
	Index     int    `json:"index"`
	BlockType string `json:"blockType"`
	Text      string `json:"text"`
	ID        string `json:"id"`
	Name      string `json:"name"`
	ArgsDelta string `json:"argumentsDelta"`
	// block-end 的整块落定内容（{type, text} 挂在 chunk.block）。
	Block *struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"block"`
}

// normalizeChunkEvent 把 assistant/chunk 翻译成 message_update 增量。
// index 是 dsh 的块索引（含 reasoning/文本/工具调用块），与前端累积位置一致。
func normalizeChunkEvent(raw json.RawMessage) rpcEvent {
	var data struct {
		Chunk dshChunkPart `json:"chunk"`
	}
	if err := json.Unmarshal(raw, &data); err != nil {
		return rpcEvent{}
	}
	part := data.Chunk
	base := map[string]any{"contentIndex": part.Index}
	switch part.Type {
	case "block-start":
		kind := "text_start"
		if part.BlockType == "reasoning" {
			kind = "thinking_start"
		}
		base["type"] = kind
	case "reasoning-delta":
		base["type"], base["delta"] = "thinking_delta", part.Text
	case "text-delta":
		base["type"], base["delta"] = "text_delta", part.Text
	case "tool-call-delta":
		if part.ID != "" && part.Name != "" {
			base["type"], base["id"], base["name"] = "toolcall_start", part.ID, part.Name
		} else {
			base["type"], base["delta"] = "toolcall_delta", part.ArgsDelta
		}
	case "block-end":
		if part.Block == nil {
			return rpcEvent{}
		}
		switch part.Block.Type {
		case "reasoning":
			base["type"], base["content"] = "thinking_end", part.Block.Text
		case "text":
			base["type"], base["content"] = "text_end", part.Block.Text
		default:
			// 工具块落定信息由 transcript 轮询提供。
			return rpcEvent{}
		}
	default:
		return rpcEvent{}
	}
	rawAME, _ := json.Marshal(base)
	return rpcEvent{Type: "message_update", AssistantMessageEvent: rawAME}
}
