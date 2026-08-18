// dshapi：DeepSeek Harness HTTP ApiProxy 客户端。
//
// dsh 的原生结构化通道不是 stdin/stdout JSONL（pi 的 --mode rpc），而是
// `dsh --profile web` 常驻宿主暴露的 HTTP API：`POST /api/<method>` 发请求
// （信封 {type:"client-request", rpcId, method, payload}，响应 server-response），
// `GET /api/events.mux` 提供 SSE 事件流。本文件只承载传输与信封，会话语义
// 与事件翻译在 dshchannel.go。
package session

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// dshHostAddr 描述一个 dsh web 宿主的 HTTP 入口；由 host 池（dshhost.go）提供。
type dshHostAddr struct {
	baseURL string // http://127.0.0.1:<port>
}

// dshEnvelope 是 dsh ApiProxy 的两种信封：client-request（发）与 server-response（收）。
// SSE 帧是第三种形态（server-request），由 readEventStream 解析。
type dshEnvelope struct {
	Type    string          `json:"type"`
	RPCID   string          `json:"rpcId,omitempty"`
	Method  string          `json:"method,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"` // client-request 的载荷
	Result  json.RawMessage `json:"result,omitempty"`  // server-response：{ok, value|error}
}

// dshRPCResult 是 server-response 的 result 字段。
type dshRPCResult struct {
	OK    bool            `json:"ok"`
	Value json.RawMessage `json:"value,omitempty"`
	Error *dshRPCError    `json:"error,omitempty"`
}

type dshRPCError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// dshAPI 是单个 dsh web 宿主的 RPC 客户端。并发安全：请求独立、互不干扰。
type dshAPI struct {
	baseURL string
	http    *http.Client
	seq     int64
	mu      sync.Mutex
}

func newDSHAPI(addr dshHostAddr) *dshAPI {
	return &dshAPI{
		baseURL: addr.baseURL,
		http:    &http.Client{Timeout: 60 * time.Second},
	}
}

func (c *dshAPI) nextID() string {
	c.mu.Lock()
	c.seq++
	id := fmt.Sprintf("ph-dsh-%d-%d", time.Now().UnixNano(), c.seq)
	c.mu.Unlock()
	return id
}

// call 发送一个 RPC 请求并返回 result.value（JSON 原始字节）。
func (c *dshAPI) call(ctx context.Context, method string, payload any) (json.RawMessage, error) {
	body, err := json.Marshal(dshEnvelope{Type: "client-request", RPCID: c.nextID(), Method: method, Payload: mustMarshal(payload)})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/api/"+method, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("dsh host %s 不可达: %w", c.baseURL, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, fmt.Errorf("读取 dsh 响应失败: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("dsh API %s 返回 %d: %s", method, resp.StatusCode, truncateUTF8(raw, 300))
	}
	var env dshEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, fmt.Errorf("解析 dsh 响应失败: %w", err)
	}
	if env.Type != "server-response" {
		return nil, fmt.Errorf("dsh 意外响应信封: %s", env.Type)
	}
	var result dshRPCResult
	if err := json.Unmarshal(env.Result, &result); err != nil {
		return nil, fmt.Errorf("解析 dsh result 失败: %w", err)
	}
	if !result.OK {
		if result.Error != nil {
			return nil, fmt.Errorf("dsh %s 失败: %s（%s）", method, result.Error.Message, result.Error.Code)
		}
		return nil, fmt.Errorf("dsh %s 失败", method)
	}
	return result.Value, nil
}

// ---------------------------------------------------------------------------
// 领域方法（payload 形状对齐 dsh-host-apiproxy 的 sessions schema）

type dshSessionCreateRequest struct {
	Cwd         string `json:"cwd,omitempty"`
	SessionID   string `json:"sessionId,omitempty"`
	AgentPreset string `json:"agentPreset,omitempty"`
}

type dshSessionCreateValue struct {
	SessionID   string `json:"sessionId"`
	AgentPreset string `json:"agentPreset,omitempty"`
}

// dshCreateSession 新建（或无 sessionId 时的首建）会话。带 sessionId 时恢复该会话。
func (c *dshAPI) createSession(ctx context.Context, cwd, resumeSessionID, agentPreset string) (dshSessionCreateValue, error) {
	var out dshSessionCreateValue
	raw, err := c.call(ctx, "session.create", dshSessionCreateRequest{
		Cwd: cwd, SessionID: resumeSessionID, AgentPreset: agentPreset,
	})
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return out, fmt.Errorf("解析 session.create 响应失败: %w", err)
	}
	if out.SessionID == "" {
		return out, errors.New("dsh session.create 未返回 sessionId")
	}
	return out, nil
}

// prompt 发送一条用户消息（mode：queue=排队等当前回合结束；steer=插入）。
// content 是内容块列表（{type:"text",text} 或 {type:"image",mediaType,data}）。
func (c *dshAPI) prompt(ctx context.Context, sessionID, mode string, content []map[string]any) error {
	_, err := c.call(ctx, "session.prompt", map[string]any{
		"sessionId": sessionID,
		"mode":      mode,
		"content":   content,
	})
	return err
}

// dshCancel 中止当前回合（abort 语义）。
func (c *dshAPI) cancel(ctx context.Context, sessionID string) error {
	_, err := c.call(ctx, "session.cancel", map[string]any{"sessionId": sessionID})
	return err
}

// dshHistory 分页读取会话事件（beforeSeq 为上一页游标；maxMessages 上限）。
func (c *dshAPI) history(ctx context.Context, sessionID string, beforeSeq int64, maxMessages int) ([]json.RawMessage, error) {
	payload := map[string]any{"sessionId": sessionID}
	if beforeSeq > 0 {
		payload["beforeSeq"] = beforeSeq
	}
	if maxMessages > 0 {
		payload["maxMessages"] = maxMessages
	}
	raw, err := c.call(ctx, "session.history", payload)
	if err != nil {
		return nil, err
	}
	var value struct {
		Events []json.RawMessage `json:"events"`
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, fmt.Errorf("解析 session.history 响应失败: %w", err)
	}
	return value.Events, nil
}

// dshSelectModel 切换会话的 provider/model/推理档位（effort 可省略）。
func (c *dshAPI) selectModel(ctx context.Context, sessionID, provider, model, effort string) error {
	payload := map[string]any{
		"sessionId": sessionID,
		"provider":  provider,
		"model":     model,
	}
	if effort != "" {
		payload["reasoningEffort"] = effort
	}
	_, err := c.call(ctx, "session.selectModel", payload)
	return err
}

// dshRename 设置会话标题。
func (c *dshAPI) rename(ctx context.Context, sessionID, title string) error {
	_, err := c.call(ctx, "session.rename", map[string]any{"sessionId": sessionID, "title": title})
	return err
}

// ---------------------------------------------------------------------------
// SSE 事件流

// dshFrame 是 mux 事件流投递的帧（server-request 信封：method 即帧类型）。
type dshFrame struct {
	Method  string          // session/event | approval/requested | question/requested | …/resolved
	RPCID   string          // 帧 rpcId（应答时回显）
	Payload json.RawMessage // 帧载荷（含 sessionId 与具体业务字段）
}

// dshEvent 是 session/event 帧载荷内嵌的事件体。
type dshEvent struct {
	Type string          `json:"type"`
	Seq  int64           `json:"seq"`
	Time int64           `json:"time"` // epoch ms
	Data json.RawMessage `json:"data"`
}

// eventStream 订阅宿主事件通道（/api/events.mux，WebSocket 升级），按会话
// 过滤后逐帧投递。连接中断（宿主重启/网络）时以非 nil error 退出，由调用方
// 决定重试或判定会话退出。
func (c *dshAPI) eventStream(ctx context.Context, sessionID string, onFrame func(dshFrame)) error {
	wsURL := "ws" + strings.TrimPrefix(c.baseURL, "http") + "/api/events.mux"
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, wsURL, nil)
	if err != nil {
		return fmt.Errorf("订阅 dsh 事件流失败: %w", err)
	}
	defer conn.Close()
	conn.SetReadLimit(16 << 20) // 单帧上限（防御巨帧）
	for {
		_, payload, err := conn.ReadMessage()
		if err != nil {
			if ctx.Err() != nil || websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				return nil
			}
			return err
		}
		var frame struct {
			Type    string          `json:"type"`
			RPCID   string          `json:"rpcId"`
			Method  string          `json:"method"`
			Payload json.RawMessage `json:"payload"`
		}
		if err := json.Unmarshal(payload, &frame); err != nil {
			continue // 防御：非 JSON 帧忽略
		}
		if frame.Type != "server-request" || frame.Method == "" {
			continue
		}
		if !frameBelongsToSession(frame.Payload, sessionID) {
			continue
		}
		onFrame(dshFrame{Method: frame.Method, RPCID: frame.RPCID, Payload: frame.Payload})
	}
}

// frameBelongsToSession 判断 mux 帧是否属于目标会话（载荷顶层带 sessionId）。
func frameBelongsToSession(payload json.RawMessage, sessionID string) bool {
	var meta struct {
		SessionID string `json:"sessionId,omitempty"`
	}
	if err := json.Unmarshal(payload, &meta); err != nil || meta.SessionID == "" {
		return false
	}
	return meta.SessionID == sessionID
}

// respond 应答宿主挂起的审批/提问帧：client-response 回显帧的 rpcId，
// value 是业务载荷（approval/outcome 或 question/answer）。HTTP 响应体是
// RpcReceipt：accepted=false 时返回错误。
func (c *dshAPI) respond(ctx context.Context, rpcID string, value any) error {
	body, err := json.Marshal(map[string]any{
		"type": "client-response", "rpcId": rpcID,
		"result": map[string]any{"ok": true, "value": value},
	})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/api/respond", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("应答 dsh 帧失败: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	var receipt struct {
		Accepted bool   `json:"accepted"`
		Reason   string `json:"reason,omitempty"`
	}
	if err := json.Unmarshal(raw, &receipt); err == nil && !receipt.Accepted {
		return fmt.Errorf("dsh 拒绝应答（%s）", receipt.Reason)
	}
	return nil
}

// mustMarshal 序列化任意 JSON 值（畸形 payload 属编程错误）。
func mustMarshal(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

func truncateUTF8(b []byte, n int) string {
	s := string(b)
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}
