package orchestrator

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
)

// mcp 是 MCP（Model Context Protocol）的极小子集，作为平台工具面：
//
//	POST /api/v1/mcp   Bearer 令牌，JSON-RPC 2.0，请求/响应均为 JSON
//
// 只实现本工具面需要的方法：initialize、notifications/initialized、
// tools/list、tools/call、ping。不做 SSE 流式（工具是单次响应）；
// 结构上保持与既有 HTTP API 同源（SSE 只用于日志流）。
const protocolVersion = "2025-03-26"

// mcpRequest 是 JSON-RPC 2.0 请求。
type mcpRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type mcpError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

type rpcJSONError struct{ err mcpError }

func (e *rpcJSONError) Error() string { return e.err.Message }

func jsonRPCError(code int, msg string) error {
	return &rpcJSONError{err: mcpError{Code: code, Message: msg}}
}

const (
	codeParseError     = -32700
	codeInvalidRequest = -32600
	codeMethodNotFound = -32601
	codeInvalidParams  = -32602
	codeInternalError  = -32603
)

// HandleHTTP 处理 POST /api/v1/mcp。
func (s *Service) HandleHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	sessionID, err := s.VerifyToken(bearerToken(r.Header.Get("Authorization")))
	if err != nil {
		writeRPCJSON(w, http.StatusUnauthorized, json.RawMessage("null"), jsonRPCError(codeInvalidRequest, "未授权：平台工具令牌无效或已过期"))
		return
	}
	var req mcpRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20))
	if err := dec.Decode(&req); err != nil {
		writeRPCJSON(w, http.StatusBadRequest, json.RawMessage("null"), jsonRPCError(codeParseError, "请求体不是合法 JSON"))
		return
	}
	if req.JSONRPC != "2.0" {
		writeRPCJSON(w, http.StatusBadRequest, json.RawMessage("null"), jsonRPCError(codeInvalidRequest, "jsonrpc 必须为 2.0"))
		return
	}
	// 通知（无 id）：MCP 规范约定不写响应。
	if len(req.ID) == 0 {
		s.handleNotification(req)
		w.WriteHeader(http.StatusAccepted)
		return
	}
	result, rpcErr := s.dispatch(r.Context(), sessionID, req)
	if rpcErr != nil {
		writeRPCJSON(w, http.StatusOK, json.RawMessage(req.ID), rpcErr)
		return
	}
	writeRPCJSON(w, http.StatusOK, json.RawMessage(req.ID), nil, result)
}

func (s *Service) handleNotification(req mcpRequest) {
	switch req.Method {
	case "notifications/initialized", "notifications/cancelled":
		// 无状态端点无需初始化会话。
	default:
		log.Printf("⚠ mcp 未知通知: %s", req.Method)
	}
}

// dispatch 分发请求并返回 result（JSON 安全值）或 rpc 错误。
func (s *Service) dispatch(ctx context.Context, sessionID int64, req mcpRequest) (any, error) {
	switch req.Method {
	case "initialize":
		return map[string]any{
			"protocolVersion": protocolVersion,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": "paihuo-orchestrator", "version": "1"},
		}, nil
	case "ping":
		return map[string]any{}, nil
	case "tools/list":
		return s.toolList(), nil
	case "tools/call":
		return s.callTool(ctx, sessionID, req.Params)
	}
	return nil, jsonRPCError(codeMethodNotFound, "未知方法: "+req.Method)
}

// toolSchema 描述工具参数（MCP 工具面定义）。
type toolSchema struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	InputSchema any    `json:"inputSchema"`
}

func (s *Service) toolList() map[string]any {
	return map[string]any{"tools": []toolSchema{
		{
			Name:        toolSpawnTask,
			Description: "在平台上创建一条真实子任务（复用目标的 Role、落入项目 worktree、上板可见、走既有交付/审批/合并链）。异步模式（sync=false，默认）立即返回回执，可并行扇出，之后用 await_tasks 轮询；同步模式（sync=true）创建后阻塞到停止点（终态或待人工审批）并直接返回结果，无需轮询——任务完成即自动交回控制权。子任务权限不得超过编排者 delegation 上限。",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"role_id":              map[string]any{"type": "integer", "description": "执行子任务的已有 Role id（必须启用）"},
					"title":                map[string]any{"type": "string", "description": "子任务标题"},
					"body":                 map[string]any{"type": "string", "description": "子任务提示词：目标 + 上下文 + 验收标准"},
					"project_id":           map[string]any{"type": "integer", "description": "子任务所属项目 id（无则不填）"},
					"perm":                 map[string]any{"type": "string", "enum": []string{"full", "review"}, "description": "默认 full（无需审批，自动合并/交付）；review=完成后需人工审批（危险活应由人把关）"},
					"run_mode":             map[string]any{"type": "string", "enum": []string{"batch"}, "description": "v1 只支持 batch"},
					"concurrent":           map[string]any{"type": "boolean", "description": "允许并发（默认 false=同项目串行）"},
					"dependency_mode":      map[string]any{"type": "string", "enum": []string{"none", "weak", "strong"}, "description": "默认 none；weak=按项目创建顺序排队；strong=需 depends_on"},
					"depends_on":           map[string]any{"type": "integer", "description": "strong 依赖的前置任务 id"},
					"block_on_failure":     map[string]any{"type": "boolean", "description": "前序失败时是否阻塞本任务"},
					"sync":                 map[string]any{"type": "boolean", "description": "默认 false=异步（返回回执后 await_tasks 轮询）；true=同步，阻塞到任务完成并返回结果"},
					"sync_timeout_seconds": map[string]any{"type": "integer", "description": "同步模式最长阻塞秒数，默认 600，上限 1800"},
				},
				"required": []string{"role_id", "title"},
			},
		},
		{
			Name:        toolAwaitTasks,
			Description: "阻塞直到指定的全部子任务到达停止点（终态或等待人工审批），返回每个的结果摘要（终态、交付状态、exit code、错误、artifact 引用）。超时返回当前进度并置 timed_out=true。等待人工审批的任务不是错误——审批闸口在人类手里，可据此决定继续等或派其他活。",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"task_ids":        map[string]any{"type": "array", "items": map[string]any{"type": "integer"}, "minItems": 1, "description": "要等待的子任务 id 列表"},
					"timeout_seconds": map[string]any{"type": "integer", "description": "最长阻塞秒数，默认 600，上限 1800"},
				},
				"required": []string{"task_ids"},
			},
		},
		{
			Name:        toolListChildren,
			Description: "列出本编排者会话名下的子任务（含状态、交付状态、artifact 引用）。parent_id 给定时返回该任务在会话树内的直接子任务。",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"parent_id":  map[string]any{"type": "integer", "description": "只查某个任务的直接子任务"},
					"session_id": map[string]any{"type": "integer", "description": "只能查自己；默认自己"},
				},
			},
		},
		{
			Name:        toolGetTaskResult,
			Description: "返回单个子任务的完整结果摘要（终态、交付状态、exit code、错误、artifact 引用）。",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"task_id": map[string]any{"type": "integer"},
				},
				"required": []string{"task_id"},
			},
		},
		{
			Name:        toolFetchArtifact,
			Description: "按需拉取本会话树内某个 artifact 的内容（默认 256KB，上限 1MB）。返回元数据 + base64 内容 + truncated。只在需要原始内容时调用，平时读摘要即可。",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"artifact_id": map[string]any{"type": "integer"},
					"max_bytes":   map[string]any{"type": "integer", "description": "内容上限，默认 262144，上限 1048576"},
				},
				"required": []string{"artifact_id"},
			},
		},
	}}
}

// callTool 执行 tools/call。正常返回 MCP 结果；工具错误放入 isError 而不作为
// JSON-RPC 错误（agent 可见并可据此修正参数）。
func (s *Service) callTool(ctx context.Context, sessionID int64, paramsRaw json.RawMessage) (any, error) {
	var params struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(paramsRaw, &params); err != nil {
		return nil, jsonRPCError(codeInvalidParams, "参数不是合法 JSON")
	}
	var payload any
	var err error
	switch params.Name {
	case toolSpawnTask:
		var args spawnArgs
		if uerr := json.Unmarshal(params.Arguments, &args); uerr != nil {
			return nil, jsonRPCError(codeInvalidParams, "spawn_task 参数非法: "+uerr.Error())
		}
		if args.Sync {
			payload, err = s.SpawnSync(ctx, sessionID, args)
		} else {
			payload, err = s.Spawn(ctx, sessionID, args)
		}
	case toolAwaitTasks:
		var args awaitArgs
		if uerr := json.Unmarshal(params.Arguments, &args); uerr != nil {
			return nil, jsonRPCError(codeInvalidParams, "await_tasks 参数非法: "+uerr.Error())
		}
		outcomes, timedOut, aerr := s.Await(ctx, sessionID, args)
		if aerr != nil {
			err = aerr
		} else {
			results := make(map[string]awaitOutcome, len(outcomes))
			for k, v := range outcomes {
				results[strconv.FormatInt(k, 10)] = v
			}
			payload = map[string]any{"results": results, "timed_out": timedOut}
		}
	case toolListChildren:
		var args listChildrenArgs
		if uerr := json.Unmarshal(params.Arguments, &args); uerr != nil {
			return nil, jsonRPCError(codeInvalidParams, "list_children 参数非法: "+uerr.Error())
		}
		payload, err = s.ListChildren(ctx, sessionID, args)
	case toolGetTaskResult:
		var args getResultArgs
		if uerr := json.Unmarshal(params.Arguments, &args); uerr != nil {
			return nil, jsonRPCError(codeInvalidParams, "get_task_result 参数非法: "+uerr.Error())
		}
		payload, err = s.GetResult(ctx, sessionID, args)
	case toolFetchArtifact:
		var args fetchArtifactArgs
		if uerr := json.Unmarshal(params.Arguments, &args); uerr != nil {
			return nil, jsonRPCError(codeInvalidParams, "fetch_artifact 参数非法: "+uerr.Error())
		}
		payload, err = s.FetchArtifact(ctx, sessionID, args)
	default:
		return nil, jsonRPCError(codeMethodNotFound, "未知工具: "+params.Name)
	}
	if err != nil {
		return map[string]any{"content": []map[string]any{{"type": "text", "text": err.Error()}}, "isError": true}, nil
	}
	b, merr := json.Marshal(payload)
	if merr != nil {
		return nil, jsonRPCError(codeInternalError, "结果序列化失败")
	}
	return map[string]any{"content": []map[string]any{{"type": "text", "text": string(b)}}, "isError": false}, nil
}

func bearerToken(header string) string {
	if header == "" {
		return ""
	}
	parts := strings.Fields(header)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return ""
	}
	return parts[1]
}

// writeRPCJSON 写 JSON-RPC 响应。result 为 nil 且 errErr 非 nil 时写 error。
func writeRPCJSON(w http.ResponseWriter, status int, id json.RawMessage, errErr error, result ...any) {
	body := map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(id)}
	if errErr != nil {
		var rpcErr *rpcJSONError
		if !errors.As(errErr, &rpcErr) {
			rpcErr = &rpcJSONError{err: mcpError{Code: codeInternalError, Message: errErr.Error()}}
		}
		body["error"] = rpcErr.err
	} else if len(result) > 0 {
		body["result"] = result[0]
	}
	w.Header().Set("Content-Type", "application/json")
	writeJSONTo(w, status, body)
}

func writeJSONTo(w http.ResponseWriter, status int, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		http.Error(w, "响应序列化失败", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(b)
}
