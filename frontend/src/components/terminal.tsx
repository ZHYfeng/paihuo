import { useEffect, useRef, useState } from "react";
import { Copy, Maximize2, MinusCircle } from "lucide-react";
import { api } from "../lib/api";
import { TerminalAdapter, type TerminalMode } from "../lib/terminal";
import { terminalRenderableLog } from "../lib/taskmeta";
import type { Task, TaskLog } from "../types";
import { Button, useToast } from "./ui";

// 每个任务一个串行按键队列：分批 ≤4096 字节发送，避免乱序/截断代理对。
const keystrokeQueues = new Map<number, string[]>();
const keystrokeFlushing = new Set<number>();

async function flushKeystrokes(taskID: number) {
  if (keystrokeFlushing.has(taskID)) return;
  const queue = keystrokeQueues.get(taskID);
  if (!queue || !queue.length) return;
  keystrokeFlushing.add(taskID);
  try {
    const batch = queue.splice(0, 4096).join("");
    await api(`/tasks/${taskID}/input`, { method: "POST", body: { keys: batch } });
  } catch { /* 失败清空队列，避免死循环重试 */ }
  keystrokeFlushing.delete(taskID);
  const rest = keystrokeQueues.get(taskID);
  if (rest?.length) void flushKeystrokes(taskID);
}

function queueKeystrokes(taskID: number, keys: string) {
  const queue = keystrokeQueues.get(taskID) || [];
  queue.push(keys);
  keystrokeQueues.set(taskID, queue);
  void flushKeystrokes(taskID);
}

export function TerminalPane({ task, logs, mode = "auto", onLoadOlder, hasMore }: {
  task: Task;
  logs: TaskLog[];
  mode?: TerminalMode | "auto";
  onLoadOlder?: () => void;
  hasMore?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const adapter = useRef<TerminalAdapter | null>(null);
  const loadingOlder = useRef(false);
  const lastSeq = useRef(0);
  const geometry = useRef({ cols: task.terminal_cols || 80, rows: task.terminal_rows || 24 });
  const effectiveMode: TerminalMode = mode === "auto"
    ? task.run_mode === "interactive" ? (task.status === "running" ? "live" : "replay") : "logs"
    : mode;
  const interactive = effectiveMode !== "logs";

  useEffect(() => {
    if (!host.current) return;
    let resizeTimer = 0;
    lastSeq.current = 0;
    const live = effectiveMode !== "logs" && task.status === "running";
    adapter.current = new TerminalAdapter(host.current, {
      onInput: live ? data => queueKeystrokes(task.id, data) : undefined,
      onResize: live ? (colCount, rowCount) => {
        window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => { void api(`/tasks/${task.id}/resize`, { method: "POST", body: { cols: colCount, rows: rowCount } }); }, 180);
      } : undefined,
      mode: effectiveMode,
      cols: geometry.current.cols,
      rows: geometry.current.rows,
    });
    return () => {
      window.clearTimeout(resizeTimer);
      adapter.current?.dispose();
      adapter.current = null;
    };
    // task.run_mode/status 变化会重建 adapter；logs 变化走 write 不重建。
  }, [task.id, task.run_mode, task.status, effectiveMode]);

  useEffect(() => {
    const adapt = adapter.current;
    if (!adapt) return;
    if (effectiveMode === "replay") {
      adapt.replaceLogs(logs.filter(terminalRenderableLog));
      adapt.scrollToTop();
      lastSeq.current = logs.reduce((max, log) => Math.max(max, log.seq || 0), 0);
      return;
    }
    const renderable = logs.filter(terminalRenderableLog);
    const fresh = renderable.filter(log => (log.seq || 0) > lastSeq.current);
    if (!fresh.length && lastSeq.current > 0) return;
    if (fresh.length < renderable.length) {
      // 顺序分页加载（loadOlder）或首屏：全量重绘。
      adapt.replaceLogs(renderable);
      lastSeq.current = renderable.reduce((max, log) => Math.max(max, log.seq || 0), 0);
    } else {
      for (const log of fresh) {
        if (log.stream === "term") adapt.appendRaw(log.content);
        else adapt.appendContent(log.content);
      }
      lastSeq.current = renderable.reduce((max, log) => Math.max(max, log.seq || 0), 0);
    }
    adapt.scrollToBottom();
  }, [logs, effectiveMode]);

  const onScroll = () => {
    const el = host.current;
    if (!el || !onLoadOlder || loadingOlder.current || hasMore === false) return;
    const scrollable = el.querySelector(".xterm-rows") as HTMLElement | null;
    if (scrollable && scrollable.scrollTop <= 0) {
      loadingOlder.current = true;
      onLoadOlder();
      setTimeout(() => { loadingOlder.current = false; }, 600);
    }
  };

  return <div className="relative">
    <div ref={host} className={`terminal-shell ${effectiveMode === "replay" ? "terminal-replay" : ""}`} style={{ minHeight: interactive ? "26rem" : "22rem" }} onScrollCapture={onScroll} aria-label="任务终端输出" />
  </div>;
}

export function TaskTerminal({ task, logs, onLoadOlder, hasMore }: {
  task: Task;
  logs: TaskLog[];
  onLoadOlder?: () => void;
  hasMore?: boolean;
}) {
  const [fullscreen, setFullscreen] = useState(false);
  return <>
    <TerminalPane task={task} logs={logs} onLoadOlder={onLoadOlder} hasMore={hasMore} />
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <Button size="sm" variant="ghost" onClick={() => setFullscreen(true)}><Maximize2 size={14} />全屏</Button>
      {onLoadOlder && hasMore !== false && <Button size="sm" variant="ghost" onClick={onLoadOlder}><MinusCircle size={14} />加载更早</Button>}
    </div>
    {fullscreen && <FullscreenTerminal task={task} logs={logs} onClose={() => setFullscreen(false)} onLoadOlder={onLoadOlder} hasMore={hasMore} />}
  </>;
}

function FullscreenTerminal({ task, logs, onClose, onLoadOlder, hasMore }: {
  task: Task;
  logs: TaskLog[];
  onClose(): void;
  onLoadOlder?: () => void;
  hasMore?: boolean;
}) {
  const toast = useToast();
  const copyScreen = async () => {
    const el = document.querySelector<HTMLElement>(".term-modal .xterm");
    const text = el ? await terminalVisibleText(el) : "";
    if (!text) { toast("终端画面为空", "bad"); return; }
    await navigator.clipboard.writeText(text);
    toast("已复制终端画面");
  };
  return <div className="fixed inset-0 z-[60] grid place-items-center bg-slate-950/70 p-2 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="全屏终端" onClick={onClose}>
    <div className="term-modal" onClick={e => e.stopPropagation()}>
      <div className="term-head">
        <span className="text-sm font-semibold text-ink">{task.role_name || "角色"} · #{task.id} 对话</span>
        <code className="ml-1 rounded-md bg-elevated px-2 py-0.5 text-xs text-muted">{task.project_dir || ""}</code>
        <span className="ml-auto flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => void copyScreen()}><Copy size={14} />复制画面</Button>
          <Button size="sm" onClick={onClose}>关闭</Button>
        </span>
      </div>
      <div className="term-body">
        <TerminalPane task={task} logs={logs} mode="auto" onLoadOlder={onLoadOlder} hasMore={hasMore} />
      </div>
      {task.run_mode === "interactive" && task.status === "running" && <div className="term-input-bar">
        <span className="text-xs text-muted">点击终端直接输入 · Tab / ↑ / ↓ 由当前 CLI 处理 · <code>{task.role_name?.toLowerCase().includes("pi") ? "/quit" : "/exit"}</code> 结束</span>
      </div>}
    </div>
  </div>;
}

async function terminalVisibleText(el: HTMLElement): Promise<string> {
  // 全屏终端由 TerminalPane 管理，直接读取可视区文本由 adapter 提供；
  // 这里从 DOM 提取 .xterm-rows 的文本行。
  const rows = el.querySelector(".xterm-rows");
  if (!rows) return "";
  return Array.from(rows.querySelectorAll("div[role='presentation']") || [])
    .map(row => row.textContent || "")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
