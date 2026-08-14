// 任务领域常量与判定（自旧前端 task.js/core.js 一比一移植）。
import type { Task, TaskLog } from "../types";

export const STATUS_LABEL: Record<string, string> = { queued: "待执行", claimed: "领取中", running: "执行中", awaiting_review: "待审批", succeeded: "完成", failed: "失败", cancelled: "已取消" };

export const PERM_LABEL: Record<string, string> = { full: "自动派发代码合并任务", review: "审批后 Agent 合并" };

export const ST_COLOR: Record<string, string> = {
  queued: "var(--st-queued)", claimed: "var(--st-claimed)", running: "var(--st-running)",
  awaiting_review: "var(--st-review)", succeeded: "var(--st-done)", failed: "var(--st-failed)", cancelled: "var(--fg-muted)"
};

// 看板列：实现任务区 3 列；合并任务区额外追加需处理列。
export const BOARD_COLS: Array<[string, string, string[]]> = [
  ["queue", "排队", ["queued", "claimed"]],
  ["running", "执行中", ["running"]],
  ["awaiting_review", "待审批", ["awaiting_review"]]
];

export function isMergeTask(t?: Task | null): boolean {
  return t?.merge_of != null;
}

export function mergeTaskFor(source: Task | null | undefined, tasks: Task[]): Task | null {
  if (!source || isMergeTask(source)) return null;
  return tasks.find(t => isMergeTask(t) && t.merge_of === source.id) || null;
}

export function mergeBlockReason(t: Task, roles: Array<{ id: number; enabled: boolean }>): string {
  if (!isMergeTask(t) || t.status !== "queued") return "";
  if (!t.role_id) return "未指派角色";
  const role = roles.find(r => r.id === t.role_id);
  if (!role) return "角色不可用";
  return role.enabled ? "" : "角色已停用";
}

type DeliveryState = { state: "pending" | "failed" | "missing" | "succeeded"; reason: string };

function sourceDeliveryInfo(source: Task | undefined, tasks: Task[]): DeliveryState {
  if (!source) return { state: "missing", reason: "前置任务已不存在" };
  if (isMergeTask(source)) return { state: "failed", reason: `任务 #${source.id} 是合并任务，不能作为前置` };
  switch (source.status) {
    case "queued": case "claimed": case "running":
      return { state: "pending", reason: `任务 #${source.id} 正在执行` };
    case "awaiting_review":
      return { state: "pending", reason: `任务 #${source.id} 等待审批` };
    case "failed":
      return { state: "failed", reason: `任务 #${source.id} 执行失败` };
    case "cancelled":
      return { state: "failed", reason: `任务 #${source.id} 已取消` };
    case "succeeded": {
      const merge = mergeTaskFor(source, tasks);
      if (!merge) {
        return source.worktree_branch
          ? { state: "pending", reason: `任务 #${source.id} 正在创建代码合并任务` }
          : { state: "succeeded", reason: `任务 #${source.id} 已完成` };
      }
      if (merge.status === "succeeded") return { state: "succeeded", reason: `合并任务 #${merge.id} 已完成` };
      if (merge.status === "failed") return { state: "failed", reason: `合并任务 #${merge.id} 失败` };
      if (merge.status === "cancelled") return { state: "failed", reason: `合并任务 #${merge.id} 已取消` };
      return { state: "pending", reason: `合并任务 #${merge.id} 正在处理` };
    }
    default:
      return { state: "pending", reason: `任务 #${source.id} 状态未知` };
  }
}

export type DependencyInfo = { mode: string; state: "ready" | "blocked" | "skipped"; label: string; reason: string; stateLabel?: string };

// 弱依赖可跳过、强依赖必须成功，与后端 Store.CheckTaskDependency 同判定。
export function dependencyInfo(t: Task, tasks: Task[]): DependencyInfo {
  if (isMergeTask(t)) return { mode: "system", state: "ready", label: "系统合并", reason: "由已完成任务自动创建" };
  const mode = t.dependency_mode || "none";
  if (mode === "none") return { mode, state: "ready", label: "独立任务", reason: "不等待项目中的其他交付" };
  if (mode === "weak" && !t.depends_on) {
    return { mode, state: "ready", label: "自动顺序 · 首项", reason: "当前项目执行顺序中的第一项" };
  }
  const source = tasks.find(x => x.id === t.depends_on);
  const prefix = mode === "strong" ? "强依赖" : "自动顺序";
  const label = `${prefix} · #${t.depends_on || "?"}`;
  if (!source) {
    if (mode === "weak") return { mode, state: "skipped", label, reason: `前序任务 #${t.depends_on} 已删除，已跳过`, stateLabel: "前序已跳过" };
    return { mode, state: "blocked", label, reason: `明确依赖的任务 #${t.depends_on} 已删除`, stateLabel: "前序不存在" };
  }
  const delivery = sourceDeliveryInfo(source, tasks);
  if (mode === "strong") {
    if (delivery.state === "succeeded") return { mode, state: "ready", label, reason: delivery.reason };
    return { mode, state: "blocked", label, reason: `明确依赖未成功：${delivery.reason}`, stateLabel: `等待 #${source.id}` };
  }
  if (delivery.state === "succeeded") return { mode, state: "ready", label, reason: delivery.reason };
  if (delivery.state === "failed" || delivery.state === "missing") {
    if (!source.block_on_failure) {
      return { mode, state: "skipped", label, reason: `前序失败，已跳过：${delivery.reason}`, stateLabel: `#${source.id} 失败已跳过` };
    }
    return { mode, state: "blocked", label, reason: `前序阻塞任务未完成：${delivery.reason}`, stateLabel: `#${source.id} 失败阻塞` };
  }
  return { mode, state: "blocked", label, reason: `等待前序交付：${delivery.reason}`, stateLabel: `等待 #${source.id}` };
}

export function canRetryTask(t: Task, tasks: Task[]): boolean {
  if (!["succeeded", "failed", "cancelled"].includes(t.status)) return false;
  if (isMergeTask(t)) return ["failed", "cancelled"].includes(t.status);
  return !(t.status === "succeeded" && (t.worktree_branch || mergeTaskFor(t, tasks)));
}

export function retryTaskLabel(t: Task): string {
  return isMergeTask(t) ? "重试合并" : "重试";
}

export function canDeleteTask(t: Task): boolean {
  return !isMergeTask(t);
}

// 详情阅读视图的日志清洗：去 ANSI 控制码与进度条重叠（\r 取最后一次绘制）。
// eslint-disable-next-line no-control-regex -- ANSI 转义序列必须按原始控制字符匹配
const ANSI_OSC_RE = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;
// eslint-disable-next-line no-control-regex
const ANSI_CSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ANSI_CHAR_RE = /\u001b[()][0-2A-Z]/g;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b[@-_]/g;

export function cleanLogContent(content: string): string {
  let text = String(content ?? "")
    .replace(ANSI_OSC_RE, "")
    .replace(ANSI_CSI_RE, "")
    .replace(ANSI_CHAR_RE, "")
    .replace(ANSI_RE, "")
    // eslint-disable-next-line no-control-regex -- NUL 字节清理
    .replace(/\u0000/g, "");
  text = text.split("\n").map(line => {
    const parts = line.split("\r");
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i] !== "") return parts[i];
    }
    return "";
  }).join("\n");
  return text;
}

// 交互终端只渲染 term/out 流；sys/in 是审计记录，混入会破坏 TUI 光标。
export function terminalRenderableLog(log: TaskLog): boolean {
  return log?.stream === "term" || log?.stream === "out" || !log?.stream;
}

export function tsOf(log: TaskLog): string {
  return String(log.created_at || "").slice(11, 19) || "";
}

export function fmtDur(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "-";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}

export function fmtPct(value: number): string {
  return `${Math.round(value)}%`;
}

// R2：解析 body 中的驳回意见标记，返回 { intro, rounds: [{round, time, note}] }
// 格式：【修改意见 第 N 轮 YYYY-MM-DD HH:MM】内容
const REVIEW_RE = /【修改意见\s*第\s*(\d+)\s*轮\s*(\d{4}-\d{2}-\d{2}\s*\d{2}:\d{2})?[^】]*】/g;

export function splitReviewRounds(body: string): { intro: string; rounds: Array<{ round: number; time: string; note: string }> } {
  const rounds: Array<{ round: number; time: string; note: string }> = [];
  let intro = String(body || "");
  let m: RegExpExecArray | null;
  let lastIdx = 0;
  const parts: string[] = [];
  REVIEW_RE.lastIndex = 0;
  while ((m = REVIEW_RE.exec(intro)) !== null) {
    const note = intro.slice(m.index + m[0].length).split(/\n\n|【修改意见/)[0].trim();
    rounds.push({ round: +m[1], time: (m[2] || "").trim(), note });
    parts.push(intro.slice(lastIdx, m.index));
    lastIdx = m.index + m[0].length;
  }
  if (parts.length) {
    // 尾部内容归属最后一条意见
    intro = parts.join("");
  }
  return { intro: intro.trim(), rounds };
}
