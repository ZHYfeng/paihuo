/**
 * PaiHuo orchestrator tool adapter (Pi extension).
 *
 * For sessions whose Role declares `delegation`, the platform injects:
 *   PAIHUO_MCP_URL      → 平台工具面端点（MCP over HTTP, JSON-RPC 2.0）
 *   PAIHUO_MCP_TOKEN    → 绑定本会话的平台令牌
 *   PAIHUO_SESSION_ID   → 本会话 task id
 *
 * This extension registers the five platform tools (spawn_task, await_tasks,
 * list_children, get_task_result, fetch_artifact) and forwards each call to the
 * platform endpoint. It is a thin transport adapter: the tool surface and all
 * security invariants (no privilege escalation, approval gates kept human)
 * live on the platform side, so any MCP-capable runtime can connect directly.
 *
 * Without the env vars (e.g. a non-delegating role), the extension loads
 * nothing and registers nothing.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MCP_URL = process.env.PAIHUO_MCP_URL;
const MCP_TOKEN = process.env.PAIHUO_MCP_TOKEN;
const SESSION_ID = process.env.PAIHUO_SESSION_ID;

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean; details?: unknown };

/** 最小 MCP JSON-RPC 客户端（无状态端点，无需 initialize 会话绑定）。 */
async function rpcCall(method: string, params?: unknown, signal?: AbortSignal): Promise<any> {
  if (!MCP_URL || !MCP_TOKEN) {
    throw new Error("平台工具面未注入（PAIHUO_MCP_URL / PAIHUO_MCP_TOKEN），本会话无法派生任务");
  }
  const body: Record<string, unknown> = { jsonrpc: "2.0", id: `ph-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, method };
  if (params !== undefined) body.params = params;
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const resp = await fetch(MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${MCP_TOKEN}` },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const data = await resp.json().catch(() => null);
    if (data?.error) {
      throw new Error(data.error.message || "平台工具面调用失败");
    }
    if (!resp.ok || data?.result === undefined) {
      throw new Error(`平台工具面调用失败（HTTP ${resp.status}）`);
    }
    return data.result;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/** tools/call：执行平台工具，返回解析后的 JSON 载荷。 */
async function callTool(name: string, args: unknown, signal?: AbortSignal): Promise<any> {
  const result = await rpcCall("tools/call", { name, arguments: args }, signal);
  for (const item of result?.content ?? []) {
    if (item?.type === "text") {
      const parsed = JSON.parse(item.text); // 平台结果始终是 JSON 文本
      if (result.isError) throw new Error(parsed || "平台工具返回错误");
      return parsed;
    }
  }
  throw new Error("平台工具响应缺少文本内容");
}

function tool(name: string, label: string, description: string, parameters: any, call: (args: any, signal?: AbortSignal) => Promise<unknown>) {
  return {
    name,
    label,
    description,
    parameters,
    promptSnippet: `PaiHuo 平台编排工具（子任务派生/等待/结果）：${name}`,
    async execute(_toolCallId: string, params: any, signal?: AbortSignal, _onUpdate?: unknown, _ctx?: ExtensionContext) {
      const value = await call(params ?? {}, signal);
      return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: {} };
    },
  };
}

export default function (pi: ExtensionAPI) {
  if (!MCP_URL || !MCP_TOKEN) {
    return; // 非委托会话：不加载任何工具
  }

  pi.registerTool(
    tool(
      "spawn_task",
      "派生任务",
      "在 PaiHuo 平台上创建一条真实子任务，复用已有 Role、落入目标项目 worktree、上板可见、走既有交付/审批/合并链。异步模式（sync=false，默认）立即返回回执，可并行扇出，之后用 await_tasks 轮询；同步模式（sync=true）创建后阻塞到停止点（终态或待人工审批）并直接返回结果——任务完成即自动交回控制权，无需轮询。子任务权限不得超过本会话的 delegation 上限；含危险动作的子任务会进入人工审批。",
      Type.Object({
        role_id: Type.Integer({ description: "执行子任务的已有 Role id（必须启用）" }),
        title: Type.String({ description: "子任务标题" }),
        body: Type.Optional(Type.String({ description: "子任务提示词：目标 + 上下文 + 验收标准" })),
        project_id: Type.Optional(Type.Integer({ description: "子任务所属项目 id（无则不填）" })),
        perm: Type.Optional(StringEnum(["full", "review"] as const)),
        concurrent: Type.Optional(Type.Boolean({ description: "允许并发（默认 false=同项目串行）" })),
        dependency_mode: Type.Optional(StringEnum(["none", "weak", "strong"] as const)),
        depends_on: Type.Optional(Type.Integer({ description: "strong 依赖的前置任务 id" })),
        block_on_failure: Type.Optional(Type.Boolean()),
        sync: Type.Optional(Type.Boolean({ description: "默认 false=异步（返回回执后 await_tasks 轮询）；true=同步，阻塞到任务完成并返回结果" })),
        sync_timeout_seconds: Type.Optional(Type.Integer({ description: "同步模式最长阻塞秒数，默认 600，上限 1800" })),
      }),
      (args, signal) => callTool("spawn_task", args, signal),
    ),
  );

  pi.registerTool(
    tool(
      "await_tasks",
      "等待子任务",
      "阻塞直到指定的全部子任务到达停止点（终态或等待人工审批），返回每个的结果摘要。超时返回当前进度并置 timed_out=true。等待人工审批不是错误——审批闸口在人类手里。",
      Type.Object({
        task_ids: Type.Array(Type.Integer(), { minItems: 1, description: "要等待的子任务 id 列表" }),
        timeout_seconds: Type.Optional(Type.Integer({ description: "最长阻塞秒数，默认 600，上限 1800" })),
      }),
      (args, signal) => callTool("await_tasks", args, signal),
    ),
  );

  pi.registerTool(
    tool(
      "list_children",
      "列出子任务",
      "列出本编排者会话名下的全部子任务（状态、交付状态、artifact 引用）。可指定 parent_id 只看某个任务的直接子任务。",
      Type.Object({
        parent_id: Type.Optional(Type.Integer()),
        session_id: Type.Optional(Type.Integer()),
      }),
      (args, signal) => callTool("list_children", args, signal),
    ),
  );

  pi.registerTool(
    tool(
      "get_task_result",
      "子任务结果",
      "返回单个子任务的完整结果摘要（终态、交付状态、exit code、错误、artifact 引用）。",
      Type.Object({ task_id: Type.Integer() }),
      (args, signal) => callTool("get_task_result", args, signal),
    ),
  );

  pi.registerTool(
    tool(
      "fetch_artifact",
      "拉取产物",
      "按需拉取本会话树内某个 artifact 的内容（默认 256KB，上限 1MB），返回元数据 + base64 内容 + truncated。",
      Type.Object({
        artifact_id: Type.Integer(),
        max_bytes: Type.Optional(Type.Integer({ description: "内容上限，默认 262144，上限 1048576" })),
      }),
      (args, signal) => callTool("fetch_artifact", args, signal),
    ),
  );
}