import { useEffect, useRef } from "react";
import { api } from "../lib/api";
import { TerminalAdapter } from "../lib/terminal";
import type { Task, TaskLog } from "../types";

export function TaskTerminal({ task, logs }: { task: Task; logs: TaskLog[] }) {
  const host = useRef<HTMLDivElement>(null);
  const adapter = useRef<TerminalAdapter | null>(null);
  useEffect(() => {
    if (!host.current) return;
    let resizeTimer = 0;
    adapter.current = new TerminalAdapter(
      host.current,
      task.run_mode === "interactive" && task.status === "running" ? data => { void api(`/tasks/${task.id}/input`, { method: "POST", body: { keys: data } }); } : undefined,
      task.run_mode === "interactive" && task.status === "running" ? (cols, rows) => {
        window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => { void api(`/tasks/${task.id}/resize`, { method: "POST", body: { cols, rows } }); }, 180);
      } : undefined
    );
    return () => { window.clearTimeout(resizeTimer); adapter.current?.dispose(); adapter.current = null; };
  }, [task.id, task.run_mode, task.status]);
  useEffect(() => {
    adapter.current?.replace(logs.map(log => log.content).join(""));
  }, [logs]);
  return <div ref={host} className="terminal-shell h-[min(58vh,42rem)]" aria-label="任务终端输出" />;
}
