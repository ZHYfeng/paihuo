import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch } from "lucide-react";
import type React from "react";
import { api, keys } from "../../lib/api";
import { STATUS_LABEL, isMergeTask, mergeTaskFor, splitReviewRounds } from "../../lib/taskmeta";
import type { Task, WorkspaceStatus } from "../../types";
import { Button, Card, useToast } from "../ui";
import { TaskStatus } from "./status";

export function TaskBody({ task }: { task: Task }) {
  const { intro, rounds } = splitReviewRounds(task.body);
  return <div className="task-prompt-body">{intro || "未填写任务说明"}
    {rounds.map(round => <div key={round.round} className="review-round"><div className="review-round-head">修改意见 · 第 {round.round} 轮{round.time ? <time>{round.time}</time> : null}</div>{round.note || ""}</div>)}
  </div>;
}

export function ChildrenSections({ task, onOpen }: { task: Task; onOpen(id: number): void }) {
  const children = useQuery({ queryKey: ["tasks", task.id, "children"], queryFn: () => api<Task[]>(`/tasks/${task.id}/children`) });
  if (!children.data?.length) return null;
  const sourceKids = children.data.filter(k => !isMergeTask(k));
  const mergeKids = children.data.filter(isMergeTask);
  const section = (title: string, items: Task[], merge: boolean) => {
    if (!items.length) return null;
    const done = items.filter(k => ["succeeded", "failed", "cancelled"].includes(k.status)).length;
    const active = items.some(k => ["queued", "claimed", "running", "awaiting_review"].includes(k.status));
    return <details className={`task-section ${merge ? "task-merge-children" : ""}`} open={active}>
      <summary><span>{title}</span><span className="section-meta">{done}/{items.length} 已结束</span></summary>
      <div className="task-subtask-list">{items.map(k => <div key={k.id} className="task-subtask" onClick={() => onOpen(k.id)} role="button" tabIndex={0} onKeyDown={e => { if (e.key === "Enter") onOpen(k.id); }}>
        <div className="flex items-center gap-2"><span className="font-semibold text-ink hover:text-brand-soft">#{k.id} {k.title}</span></div>
        <div className="c-meta">{isMergeTask(k) ? <span className="chip merge">代码合并</span> : null}<TaskStatus status={k.status} /><span className="c-agent">{k.role_name || ""}</span></div>
      </div>)}</div>
    </details>;
  };
  return <>{section("子任务", sourceKids, false)}{section("代码合并任务", mergeKids, true)}</>;
}

export function WorkspaceCard({ task }: { task: Task }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const workspace = useQuery({ queryKey: ["tasks", task.id, "workspace"], queryFn: () => api<WorkspaceStatus>(`/workspace/${task.id}`) });
  const discardWs = useMutation({
    mutationFn: () => api(`/workspace/${task.id}/discard`, { method: "POST" }),
    onSuccess: () => { toast("已丢弃"); queryClient.invalidateQueries({ queryKey: ["tasks", task.id, "workspace"] }); },
    onError: error => toast((error as Error).message, "bad")
  });
  const gitInit = useMutation({
    mutationFn: () => api(`/workspace/git-init`, { method: "POST", body: { path: task.project_dir } }),
    onSuccess: () => { toast("已初始化"); queryClient.invalidateQueries({ queryKey: ["tasks", task.id, "workspace"] }); queryClient.invalidateQueries({ queryKey: keys.projects }); },
    onError: error => toast((error as Error).message, "bad")
  });
  const w = workspace.data;
  if (!w) return null;
  const done = ["succeeded", "failed", "cancelled"].includes(task.status);
  const sourceMerge = mergeTaskFor(task, []);
  const sourceAwaitingMerge = !isMergeTask(task) && task.status === "succeeded";
  let actions: React.ReactNode = null;
  if (isMergeTask(task)) {
    if (task.status === "succeeded") actions = <div className="ws-actions"><span className="ws-val">代码已由本合并任务自动写入主分支</span><Button size="sm" variant="danger" onClick={() => confirm(`丢弃任务 #${task.id} 的工作空间？分支与 worktree 将删除，改动不可恢复。`) && discardWs.mutate()}>清理工作空间</Button></div>;
    else actions = <div className="ws-actions"><span className="ws-val">{task.status === "failed" || task.status === "cancelled" ? "请使用“重试合并”继续处理。" : "代码将由本合并任务成功结算时自动写入主分支。"}</span></div>;
  } else if (sourceAwaitingMerge) {
    actions = <div className="ws-actions"><span className="ws-val">{sourceMerge ? `代码由合并任务 #${sourceMerge.id}（${STATUS_LABEL[sourceMerge.status] || sourceMerge.status}）处理` : "代码已完成，系统正在补建代码合并任务"}</span></div>;
  } else if (done) {
    actions = <div className="ws-actions"><Button size="sm" variant="danger" onClick={() => confirm(`丢弃任务 #${task.id} 的工作空间？分支与 worktree 将删除，改动不可恢复。`) && discardWs.mutate()}>丢弃</Button></div>;
  }
  if (!w.is_git) {
    return <Card><h2 className="font-semibold">工作空间</h2>
      <div className="ws-row mt-2"><span className="ws-label">隔离</span><span className="ws-val">项目非 git 仓库，任务直接在项目目录执行</span>{task.project_dir ? <Button size="sm" disabled={gitInit.isPending} onClick={() => confirm(`在 ${task.project_dir} 初始化 git 仓库？之后的任务将获得独立 worktree。`) && gitInit.mutate()}><GitBranch size={14} />git init</Button> : null}</div>
    </Card>;
  }
  if (!w.is_worktree) {
    return <Card><h2 className="font-semibold">工作空间</h2>
      <div className="ws-row mt-2"><span className="ws-label">隔离</span><span className="ws-val">{w.note || "无独立工作空间"}</span></div>
    </Card>;
  }
  return <Card><h2 className="font-semibold">工作空间</h2><dl className="mt-2 grid gap-1.5 text-sm">
    <div className="ws-row"><span className="ws-label">分支</span><span className="ws-val mono font-mono">{w.branch}</span></div>
    <div className="ws-row"><span className="ws-label">HEAD</span><span className="ws-val mono font-mono">{w.head || "-"}{w.dirty ? <span className="ws-tag dirty">dirty</span> : null}{w.ahead > 0 ? <span className="ws-tag ahead">+{w.ahead}</span> : null}</span></div>
    <div className="ws-row"><span className="ws-label">路径</span><span className="ws-val mono font-mono" title={w.path}>{w.path}</span></div>
  </dl>{actions}</Card>;
}

export function LogFilterToggle({ mode, onToggle }: { mode: "all" | "err"; onToggle(): void }) {
  return <Button size="sm" variant="ghost" className={mode === "err" ? "active-filter" : ""} onClick={onToggle}>{mode === "err" ? "✓ " : ""}只看错误</Button>;
}
