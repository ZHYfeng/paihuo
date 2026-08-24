import { useMemo, useState } from "react";
import { inputClass } from "../ui";
import { dependencyInfo, isMergeTask, mergeTaskFor, STATUS_LABEL } from "../../lib/taskmeta";
import type { Task } from "../../types";

export function DependencyChip({ task, tasks }: { task: Task; tasks: Task[] }) {
  const info = dependencyInfo(task, tasks);
  if (info.mode === "system") return null;
  const kind = info.mode === "strong" ? "strong" : info.mode === "weak" ? "weak" : "none";
  return <span className={`chip dependency ${kind}`} title={info.reason || info.label}>{info.label}</span>;
}

export function DependencyStateChip({ task, tasks }: { task: Task; tasks: Task[] }) {
  if (task.status !== "queued") return null;
  const info = dependencyInfo(task, tasks);
  if (info.state === "blocked") return <span className="chip dependency blocked" title={info.reason}>{info.stateLabel || "等待前序"}</span>;
  if (info.state === "skipped") return <span className="chip dependency skipped" title={info.reason}>{info.stateLabel || "前序已跳过"}</span>;
  return null;
}

type TaskDependencyMode = "none" | "weak" | "strong";

function taskDependencyMode(task: Task): TaskDependencyMode {
  if (task.dependency_mode === "weak" || task.dependency_mode === "strong") return task.dependency_mode;
  return "none";
}

export function TaskDependencyEditor({ task, tasks, disabled, onChange }: { task: Task; tasks: Task[]; disabled?: boolean; onChange(body: Record<string, unknown>): void }) {
  const [mode, setMode] = useState<TaskDependencyMode>(() => taskDependencyMode(task));
  const [target, setTarget] = useState(task.depends_on ? String(task.depends_on) : "");
  const candidates = useMemo(() => tasks
    .filter(item => item.id !== task.id && item.type === "task" && !isMergeTask(item) && !item.cron && item.project_id === task.project_id)
    .sort((a, b) => b.id - a.id), [task.id, task.project_id, tasks]);
  const selectMode = (next: TaskDependencyMode) => {
    setMode(next);
    if (next === "strong") {
      if (target) onChange({ dependency_mode: next, depends_on: Number(target) });
      return;
    }
    setTarget("");
    onChange({ dependency_mode: next, depends_on: null });
  };
  const selectTarget = (value: string) => {
    setTarget(value);
    if (value) onChange({ dependency_mode: "strong", depends_on: Number(value) });
  };
  return <span className="flex min-w-0 flex-wrap items-center gap-1.5">
    <select className={inputClass + " py-0.5 text-xs"} value={mode} disabled={disabled} aria-label="前置交付模式" onChange={e => selectMode(e.target.value as TaskDependencyMode)}>
      <option value="none">独立执行</option>
      <option value="weak">自动顺序</option>
      <option value="strong">明确前置</option>
    </select>
    {mode === "strong" ? <select className={inputClass + " min-w-40 py-0.5 text-xs"} value={target} disabled={disabled} aria-label="前置任务" onChange={e => selectTarget(e.target.value)}>
      <option value="">选择前置任务</option>
      {candidates.map(item => <option key={item.id} value={item.id}>#{item.id} · {item.title}</option>)}
    </select> : null}
    {mode === "strong" && !target ? <span className="text-xs text-warning">请选择前置任务</span> : null}
  </span>;
}

export function SourceMergeChip({ task, tasks }: { task: Task; tasks: Task[] }) {
  if (isMergeTask(task)) return null;
  const merge = mergeTaskFor(task, tasks);
  if (!merge) {
    return task.status === "succeeded" && task.worktree_branch
      ? <span className="chip merge-pending">正在创建合并</span> : null;
  }
  return <span className={`chip merge-state ${merge.status}`} title={`代码合并任务 #${merge.id}`}>合并：{STATUS_LABEL[merge.status] || merge.status}</span>;
}
