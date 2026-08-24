import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CirclePlus, ListFilter, RotateCcw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PageHeader } from "../../components/shell";
import { BoardColumnsHTML, taskChips } from "../../components/task/task-card";
import { NewTaskDialog } from "../../components/task/create-dialog";
import { formatTime } from "../../components/task/format";
import { StatsStrip } from "../../components/task/stats-strip";
import { TaskStatus } from "../../components/task/status";
import { Button, Card, Empty, inputClass, Spinner, useToast } from "../../components/ui";
import { useTasks, useTaskStatusMutation } from "../../hooks/useTasks";
import { useHotkeys } from "../../lib/hotkeys";
import { api, keys } from "../../lib/api";
import { STATUS_LABEL, canDeleteTask, canRetryTask, isMergeTask, mergeBlockReason, retryTaskLabel } from "../../lib/taskmeta";
import type { Project, Role, Task } from "../../types";

export function BoardPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const [view, setView] = useState<"board" | "list">("board");
  const [roleID, setRoleID] = useState("");
  const [project, setProject] = useState("");
  const [status, setStatus] = useState("");
  const tasks = useTasks();
  const projects = useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/projects") });
  const roles = useQuery({ queryKey: keys.roles, queryFn: () => api<Role[]>("/roles") });
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const all = useMemo(() => tasks.data || [], [tasks.data]);
  const filtered = useMemo(() => all.filter(task => {
    if (roleID && task.role_id !== Number(roleID)) return false;
    if (project && task.project_id !== Number(project)) return false;
    if (status && task.status !== status) return false;
    return true;
  }), [all, roleID, project, status]);
  const sourceTasks = filtered.filter(task => !isMergeTask(task));
  const mergeTasks = filtered.filter(isMergeTask);
  const mutateStatus = useTaskStatusMutation();
  const removeTask = useMutation({
    mutationFn: (task: Task) => api(`/tasks/${task.id}`, { method: "DELETE", revision: task.revision }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: keys.tasks }); queryClient.invalidateQueries({ queryKey: keys.stats }); toast("已删除"); },
    onError: error => toast((error as Error).message, "bad")
  });
  useHotkeys({ newTask: () => setCreateOpen(true) });
  return <>
    <PageHeader title="任务" copy="任务状态机、依赖交付、审批和代码整合保持确定性。" actions={<Button variant="primary" onClick={() => setCreateOpen(true)}><CirclePlus size={17} />新建任务</Button>} />
    <StatsStrip />
    <Card className="mb-4 mt-3 flex flex-col gap-2 p-3 sm:flex-row sm:flex-wrap sm:items-center">
      <span className="flex shrink-0 items-center gap-2 px-2 text-sm text-muted whitespace-nowrap"><ListFilter size={16} />筛选</span>
      <select className={inputClass + " sm:w-40"} value={roleID} onChange={event => setRoleID(event.target.value)} aria-label="按角色筛选"><option value="">全部角色</option>{roles.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <select className={inputClass + " sm:w-44"} value={project} onChange={event => setProject(event.target.value)} aria-label="按项目筛选"><option value="">全部项目</option>{projects.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <select className={inputClass + " sm:w-36"} value={status} onChange={event => setStatus(event.target.value)} aria-label="按状态筛选"><option value="">全部状态</option>{Object.entries(STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <span className="whitespace-nowrap text-sm text-muted sm:ml-auto">{sourceTasks.length} 个实现 · {mergeTasks.length} 个合并</span>
      <div className="flex shrink-0 rounded-xl border border-line bg-elevated p-0.5" role="tablist" aria-label="视图切换">
        <button role="tab" aria-selected={view === "board"} className={`rounded-[10px] whitespace-nowrap px-2.5 py-1 text-[13px] ${view === "board" ? "bg-surface font-semibold text-ink shadow-sm" : "text-muted"}`} onClick={() => setView("board")}>看板</button>
        <button role="tab" aria-selected={view === "list"} className={`rounded-[10px] whitespace-nowrap px-2.5 py-1 text-[13px] ${view === "list" ? "bg-surface font-semibold text-ink shadow-sm" : "text-muted"}`} onClick={() => setView("list")}>列表</button>
      </div>
    </Card>
    {tasks.isLoading ? <Spinner /> : view === "board" ? <div className="grid grid-cols-1 gap-4">
      <section className="board-section"><div className="board-section-head"><div><h2>实现任务</h2><p>项目任务默认按创建时间顺序交付，也可在项目页调整；每项完成后会先处理自己的代码合并。</p></div><div className="board-section-counts"><span>{sourceTasks.length} 个</span></div></div>
        <div className="board-section-lanes">{sourceTasks.length ? <BoardColumnsHTML tasks={sourceTasks} roles={roles.data || []} mergeSection={false} /> : <div className="board-section-empty">没有符合条件的实现任务。</div>}</div></section>
      <section className="board-section merge-section"><div className="board-section-head"><div><h2>代码合并</h2><p>无冲突时平台直接整合；有冲突时 agent 在独立 worktree 中解决后写入主分支。</p></div><div className="board-section-counts"><span>{mergeTasks.length} 个</span>{mergeTasks.filter(t => mergeBlockReason(t, roles.data || [])).length ? <span className="chip merge-blocked">{mergeTasks.filter(t => mergeBlockReason(t, roles.data || [])).length} 个角色不可用</span> : null}</div></div>
        <div className="board-section-lanes">{mergeTasks.length ? <BoardColumnsHTML tasks={mergeTasks} roles={roles.data || []} mergeSection={true} /> : <div className="board-section-empty">还没有代码合并任务；实现任务完成后会自动出现在这里。</div>}</div></section>
    </div> : <Card className="overflow-x-auto p-0"><table className="w-full text-sm"><thead><tr className="border-b border-line text-left text-xs text-faint">
      <th className="whitespace-nowrap px-3 py-2 font-medium">ID</th><th className="whitespace-nowrap px-3 py-2 font-medium">标题</th><th className="whitespace-nowrap px-3 py-2 font-medium">类型</th><th className="whitespace-nowrap px-3 py-2 font-medium">角色</th><th className="whitespace-nowrap px-3 py-2 font-medium">项目</th><th className="whitespace-nowrap px-3 py-2 font-medium">状态</th><th className="whitespace-nowrap px-3 py-2 font-medium">轮次</th><th className="whitespace-nowrap px-3 py-2 font-medium">创建</th><th className="whitespace-nowrap px-3 py-2 font-medium">结束</th><th className="whitespace-nowrap px-3 py-2 font-medium">操作</th>
    </tr></thead><tbody className="divide-y divide-line">{filtered.map(task => <tr key={task.id} className="list-row hover:bg-hover" onClick={() => navigate(`/tasks/${task.id}`)}>
      <td className="whitespace-nowrap px-3 py-2 text-faint">#{task.id}</td>
      <td className="t-title whitespace-nowrap px-3 py-2"><Link to={`/tasks/${task.id}`} onClick={e => e.stopPropagation()} className="hover:text-brand-soft">{task.title}</Link>{isMergeTask(task) ? <span className="chip merge ml-1">合并 #{task.merge_of}</span> : null}</td>
      <td className="px-3 py-2"><span className="task-list-chips">{taskChips(task, all, roles.data || [])}</span></td>
      <td className="whitespace-nowrap px-3 py-2 text-muted">{task.role_name || "-"}</td>
      <td className="whitespace-nowrap px-3 py-2 text-muted">{task.project_name || "-"}</td>
      <td className="px-3 py-2"><TaskStatus status={task.status} /></td>
      <td className="whitespace-nowrap px-3 py-2 text-faint">{task.review_rounds || "—"}</td>
      <td className="whitespace-nowrap px-3 py-2 text-faint">{formatTime(task.created_at)}</td>
      <td className="whitespace-nowrap px-3 py-2 text-faint">{formatTime(task.finished_at)}</td>
      <td className="px-3 py-2"><span className="ops inline-flex gap-1.5">
        {canRetryTask(task, all) ? <Button size="sm" variant="ghost" title={retryTaskLabel(task)} onClick={e => { e.stopPropagation(); mutateStatus.mutate({ id: task.id, status: "queued", revision: task.revision }); }}><RotateCcw size={13} /><span className="hidden sm:inline">{retryTaskLabel(task)}</span></Button> : null}
        {canDeleteTask(task) ? <Button size="sm" variant="danger" title="删除任务" onClick={e => { e.stopPropagation(); if (confirm(`删除任务 #${task.id}？执行日志、worktree、任务分支及其合并子任务将一并删除。`)) removeTask.mutate(task); }}><Trash2 size={13} /><span className="hidden sm:inline">删除</span></Button> : null}
      </span></td>
    </tr>)}</tbody></table>{!filtered.length ? <div className="p-8"><Empty title="没有符合条件的任务" copy="调整筛选条件试试。" /></div> : null}</Card>}
    <NewTaskDialog open={createOpen} onOpenChange={setCreateOpen} />
  </>;
}

/* ============================================================
   历史
   ============================================================ */
