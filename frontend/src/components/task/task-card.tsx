import type React from "react";
import { Link } from "react-router-dom";
import { BOARD_COLS, ST_COLOR, isMergeTask, mergeBlockReason } from "../../lib/taskmeta";
import type { Role, Task } from "../../types";
import { DependencyChip, DependencyStateChip, SourceMergeChip } from "./dependency-editor";
import { formatTime } from "./format";
import { TaskStatus } from "./status";
import { ArrowUpRight, GitMerge } from "lucide-react";

function TaskKindChip({ task }: { task: Task }) {
  return isMergeTask(task)
    ? <span className="chip merge" title={`由源任务 #${task.merge_of} 自动创建`}>代码合并 · #{task.merge_of}</span>
    : <span className="chip task-kind">实现</span>;
}
export function taskChips(task: Task, tasks: Task[], roles: Role[]): React.ReactNode {
  const blocked = mergeBlockReason(task, roles);
  return <>
    <TaskKindChip task={task} />
    <DependencyChip task={task} tasks={tasks} />
    <DependencyStateChip task={task} tasks={tasks} />
    <SourceMergeChip task={task} tasks={tasks} />
    {blocked ? <span className="chip merge-blocked">{blocked}</span> : null}
    {task.perm === "review" ? <span className="chip review">审批</span> : null}
    {task.run_mode === "interactive" ? <span className="chip">交互</span> : null}
    {task.concurrent ? <span className="chip">并发</span> : null}
    {task.review_rounds > 0 ? <span className="chip">第{task.review_rounds}轮</span> : null}
  </>;
}

export function avatarInitial(name: string) { return (name || "?").slice(0, 1); }

/* ---- 工作台卡片（旧 dashboard.js dashCardHTML） ---- */

export function DashCard({ task }: { task: Task }) {
  return <Link to={`/tasks/${task.id}`} className="queue-task">
    <span className="queue-task-symbol">{isMergeTask(task) ? <GitMerge size={17} /> : <span className="st-dot" style={{ background: ST_COLOR[task.status] }} />}</span>
    <span className="queue-task-content"><b>{task.title}</b><span><code>#{task.id}</code><i />{task.project_name || "未绑定项目"}<i />{formatTime(task.created_at)}</span></span>
    <span className="queue-task-role" title={task.role_name || "未指派"}><span>{avatarInitial(task.role_name || "")}</span>{task.role_name || "未指派"}</span>
    <TaskStatus status={task.status} /><ArrowUpRight size={15} className="queue-task-arrow" />
  </Link>;
}

/* ============================================================
   工作台
   ============================================================ */
export function TaskCard({ task, tasks, roles }: { task: Task; tasks: Task[]; roles: Role[] }) {
  return <Link to={`/tasks/${task.id}`} className="card task-card block rounded-xl border border-line bg-surface p-3 shadow-card transition hover:border-brand/35 hover:bg-hover" style={{ "--st-color": ST_COLOR[task.status] } as React.CSSProperties}>
    <div className="flex items-center gap-1.5 text-[11px] text-faint"><span className="st-dot" style={{ background: ST_COLOR[task.status] }} /><span className="font-bold text-muted">#{task.id}</span><time className="text-faint">{formatTime(task.created_at)}</time></div>
    <div className="mt-1 text-[13px] font-semibold leading-5 text-ink">{task.title}</div>
    {task.body ? <div className="mt-1 line-clamp-2 text-xs leading-4 text-muted">{task.body}</div> : null}
    {task.error ? <div className="mt-1 line-clamp-2 text-xs leading-4 text-danger" title={task.error}>{task.error}</div> : null}
    <div className="mt-1.5 flex flex-wrap items-center gap-1">{taskChips(task, tasks, roles)}</div>
    <div className="c-meta mt-1.5 flex items-center gap-1.5 text-xs text-muted">
      {task.project_id && task.project_name ? <span className="chip" title={task.project_name}>{task.project_name}</span> : null}
      <span className="ml-auto flex items-center gap-1">{task.role_name ? <span className="flex items-center gap-1"><span className="grid size-5 place-items-center rounded-full bg-brand/10 text-[10px] font-semibold text-brand-soft">{avatarInitial(task.role_name)}</span><span className="c-agent-name">{task.role_name}</span></span> : <span className="text-faint">未指派</span>}
        {task.error ? <span className="text-danger">✗</span> : null}</span>
    </div>
  </Link>;
}

export function BoardColumnsHTML({ tasks, roles, mergeSection }: { tasks: Task[]; roles: Role[]; mergeSection: boolean }) {
  const columns: Array<[string, string, string[]]> = mergeSection
    ? [...BOARD_COLS, ["merge-attention", "需处理", ["failed", "cancelled"]]]
    : BOARD_COLS;
  return <>{columns.map(([key, label, statuses]) => {
    const items = tasks.filter(t => statuses.includes(t.status));
    return <div key={key} className="board-col" style={{ "--st-color": ST_COLOR[statuses[0]] } as React.CSSProperties}>
      <div className="board-col-head"><span className="st-dot" /><span>{label}</span><span className="count">{items.length}</span></div>
      <div className="board-col-body">{items.map(task => <TaskCard key={task.id} task={task} tasks={tasks} roles={roles} />)}{!items.length ? <div className="empty">暂无</div> : null}</div>
    </div>;
  })}</>;
}
