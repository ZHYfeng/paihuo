import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, CirclePlus, RotateCcw, Settings, Trash2 } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { PageHeader } from "../../components/shell";
import { DailyChart } from "../../components/project/stats";
import { MutationError } from "../../components/project/mutation-error";
import { NewTaskDialog } from "../../components/task/create-dialog";
import { TaskStatus } from "../../components/task/status";
import { Badge, Button, Card, Dialog, Empty, Field, inputClass, Spinner, useToast } from "../../components/ui";
import { api, keys } from "../../lib/api";
import { dependencyInfo, fmtDur, fmtPct } from "../../lib/taskmeta";
import type { Project, ProjectStats, Role, Task } from "../../types";

export function ProjectDetailPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const project = useQuery({ queryKey: [...keys.projects, id], queryFn: () => api<Project[]>("/projects").then(list => list.find(item => item.id === id)) });
  const stats = useQuery({ queryKey: ["stats", "project", id], queryFn: () => api<ProjectStats>(`/stats/projects/${id}`) });
  const tasks = useQuery({ queryKey: ["tasks", "project", id], queryFn: () => api<Task[]>(`/tasks?project_id=${id}`) });
  const roles = useQuery({ queryKey: keys.roles, queryFn: () => api<Role[]>("/roles") });
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<Partial<Project> | null>(null);
  const implementations = useMemo(() => (tasks.data || []).filter(task => task.merge_of == null).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)), [tasks.data]);
  const merges = useMemo(() => (tasks.data || []).filter(task => task.merge_of != null), [tasks.data]);
  const [dragging, setDragging] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const pendingCount = implementations.filter(task => task.status === "queued").length;
  const reorder = useMutation({
    mutationFn: (taskIDs: number[]) => api<Task[]>(`/projects/${id}/tasks/order`, { method: "PUT", revision: project.data?.revision, body: { task_ids: taskIDs } }),
    onSuccess: data => { qc.setQueryData(["tasks", "project", id], data); qc.invalidateQueries({ queryKey: keys.tasks }); },
    onError: error => toast((error as Error).message, "bad")
  });
  const patch = useMutation({
    mutationFn: ({ taskID, revision, body }: { taskID: number; revision: number; body: Record<string, unknown> }) => api(`/tasks/${taskID}`, { method: "PATCH", revision, body }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["tasks", "project", id] }); qc.invalidateQueries({ queryKey: keys.tasks }); },
    onError: error => toast((error as Error).message, "bad")
  });
  const removeTask = useMutation({
    mutationFn: (task: Task) => api(`/tasks/${task.id}`, { method: "DELETE", revision: task.revision }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["tasks", "project", id] }); qc.invalidateQueries({ queryKey: keys.tasks }); },
    onError: error => toast((error as Error).message, "bad")
  });
  const saveSettings = useMutation({
    mutationFn: (value: Partial<Project>) => api<Project>(`/projects/${value.id}`, { method: "PATCH", revision: value.revision, body: { name: value.name, description: value.description, project_dir: value.project_dir, status: value.status, github_repo: value.github_repo || "", github_role_id: value.github_role_id ?? null, github_auto_issues: !!value.github_auto_issues, github_auto_prs: !!value.github_auto_prs, github_auto_security: !!value.github_auto_security } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: keys.projects }); setSettingsOpen(false); toast("项目设置已保存"); },
    onError: error => toast((error as Error).message, "bad")
  });
  const pendingItems = implementations.filter(task => task.status === "queued");
  const pendingIndex = useMemo(() => new Map(pendingItems.map((task, index) => [task.id, index])), [pendingItems]);
  const move = (taskID: number, direction: -1 | 1) => {
    const index = pendingIndex.get(taskID);
    if (index == null) return;
    const target = index + direction;
    if (target < 0 || target >= pendingItems.length || reorder.isPending) return;
    const next = [...pendingItems];
    [next[index], next[target]] = [next[target], next[index]];
    // 后端只接受项目内全部「待执行」实现任务的排序请求；非排队任务不可重排。
    reorder.mutate(next.map(task => task.id));
  };
  const onDragStart = (taskID: number) => { setDragging(taskID); };
  const onDrop = (targetID: number) => {
    setDragging(null);
    setDragOver(null);
    if (dragging == null || dragging === targetID) return;
    const from = pendingIndex.get(dragging);
    const to = pendingIndex.get(targetID);
    if (from == null || to == null) return;
    const next = [...pendingItems];
    next.splice(to, 0, next.splice(from, 1)[0]);
    reorder.mutate(next.map(task => task.id));
  };
  if (project.isLoading || stats.isLoading) return <Spinner />;
  if (!project.data) return <Empty title="项目不存在" copy="它可能已被删除。" />;
  const value = project.data;
  const stat = stats.data;
  const counts = stat?.status_counts || [];
  const review = counts.find(item => item.status === "awaiting_review");
  const agents = stat?.roles || [];
  const projectTasks = tasks.data || [];
  return <>
    <PageHeader title={value.name} copy={value.description || value.project_dir || undefined} actions={<>
      <Badge tone={value.status === "active" ? "good" : "neutral"}>{value.status === "active" ? "进行中" : "已归档"}</Badge>{value.is_git && <Badge tone="info">Git</Badge>}
      <Button variant="ghost" onClick={() => navigate("/projects")}>返回</Button>
      <Button variant="ghost" onClick={() => { setSettings({ ...value, github_repo: value.github_repo || "", github_auto_issues: !!value.github_auto_issues, github_auto_prs: !!value.github_auto_prs, github_auto_security: !!value.github_auto_security }); setSettingsOpen(true); }}><Settings size={16} />设置</Button>
      <Button variant="primary" onClick={() => setCreateOpen(true)}><CirclePlus size={16} />新建任务</Button>
    </>} />
    {value.description ? <div className="detail-desc mt-1">{value.description}</div> : null}
    {stat ? <div className="mt-3 grid gap-3 lg:grid-cols-[auto_minmax(0,1fr)]">
      <div className="ring" style={{ background: `conic-gradient(var(--brand) ${Math.round(Math.min(100, stat.progress || 0) * 3.6)}deg, color-mix(in srgb, var(--ink) 9%, transparent) 0)` }}>
        <div className="ring-inner"><b>{fmtPct(stat.progress || 0)}</b><span>完成度</span></div>
      </div>
      <div className="grid content-start gap-3">
        <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
          {([["进行中", stat.in_flight || 0, "var(--st-running)"], ["待审批", review?.count || 0, "var(--st-review)"], ["完成", stat.succeeded, "var(--st-done)"], ["失败", stat.failed, "var(--st-failed)"], ["实现任务", implementations.length, "var(--muted)"], ["合并任务", merges.length, "var(--merge-accent)"]] as Array<[string, number, string]>).map(([label, num, color]) => <div key={label} className="stat-chip"><span className="sc-dot" style={{ background: color }} /><b>{num}</b><span className="sc-label">{label}</span></div>)}
        </div>
        <div className="text-xs font-semibold uppercase tracking-wide text-faint">近 14 天完成</div>
        <DailyChart daily={stat.daily || []} days={14} />
      </div>
    </div> : null}
    <Card className="mt-4"><div className="mb-3 flex items-center"><div><h2 className="font-semibold">任务</h2><p className="mt-1 text-sm text-muted">待执行任务可拖动或用箭头调整顺序，默认按创建时间。</p></div><span className="ml-auto text-sm text-muted">{implementations.length} 个实现 · {merges.length} 个合并</span></div>
      {tasks.isLoading ? <Spinner /> : implementations.length ? <div className="grid gap-2">
        {implementations.map(task => {
          const queued = task.status === "queued";
          const info = dependencyInfo(task, projectTasks);
          return <div key={task.id} className={`flex items-center gap-2 rounded-xl border bg-elevated p-2 pl-3 ${dragging === task.id ? "sortable-task-row dragging opacity-40" : ""} ${dragOver === task.id ? "border-brand/60" : "border-line"}`}
            draggable={queued && pendingCount > 1} onDragStart={() => onDragStart(task.id)} onDragOver={e => { if (queued) { e.preventDefault(); setDragOver(task.id); } }} onDragLeave={() => setDragOver(prev => prev === task.id ? null : prev)} onDrop={e => { e.preventDefault(); if (queued) onDrop(task.id); }} onDragEnd={() => { setDragging(null); setDragOver(null); }}>
            {queued && pendingCount > 1 ? <span className="task-drag-handle" title="拖动调整执行顺序" aria-label="拖动调整执行顺序">⠿</span> : null}
            <Link to={`/tasks/${task.id}`} className="group min-w-0 flex-1"><span className="block truncate text-sm font-medium group-hover:text-brand-soft">#{task.id} {task.title}</span>
              <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted"><span>{task.role_name || "未指派"}</span><TaskStatus status={task.status} />
                {queued && info.state === "blocked" ? <span className="chip dependency blocked" title={info.reason}>{info.stateLabel || "等待前序"}</span> : null}</span></Link>
            {queued && pendingCount > 1 ? <div className="task-order-actions">
              <button className="grid size-7 place-items-center rounded-lg text-muted hover:bg-hover hover:text-ink disabled:opacity-30" disabled={(pendingIndex.get(task.id) ?? 0) === 0 || reorder.isPending} aria-label={`上移任务 ${task.title}`} onClick={() => move(task.id, -1)}><ArrowUp size={15} /></button>
              <button className="grid size-7 place-items-center rounded-lg text-muted hover:bg-hover hover:text-ink disabled:opacity-30" disabled={(pendingIndex.get(task.id) ?? 0) === pendingItems.length - 1 || reorder.isPending} aria-label={`下移任务 ${task.title}`} onClick={() => move(task.id, 1)}><ArrowDown size={15} /></button>
            </div> : null}
            <div className="flex gap-1">
              {task.status === "queued" && <Button size="sm" variant="ghost" aria-label={`重试任务 ${task.title}`} title="重试" onClick={() => patch.mutate({ taskID: task.id, revision: task.revision, body: { status: "queued" } })}><RotateCcw size={13} /></Button>}
              <Button size="sm" variant="danger" aria-label={`删除任务 ${task.title}`} title="删除任务" onClick={() => confirm(`删除任务 #${task.id}？`) && removeTask.mutate(task)}><Trash2 size={13} /></Button>
            </div>
          </div>;
        })}
      </div> : <Empty title="还没有任务" copy="创建任务并绑定此项目，执行顺序会显示在这里。" action={<Button size="sm" variant="primary" onClick={() => setCreateOpen(true)}><CirclePlus size={15} />派活</Button>} />}
      {merges.length ? <><h3 className="mb-2 mt-4 text-sm font-semibold text-muted">代码合并 {merges.length}</h3><div className="grid gap-2">{merges.map(task => <Link key={task.id} to={`/tasks/${task.id}`} className="flex items-center gap-2 rounded-xl border border-line bg-elevated px-3 py-2.5"><span className="chip merge">合并 #{task.merge_of}</span><span className="min-w-0 flex-1 truncate text-sm font-medium hover:text-brand-soft">{task.title}</span><TaskStatus status={task.status} /></Link>)}</div></> : null}
    </Card>
    {agents.length ? <Card className="mt-4"><h2 className="font-semibold">成员统计</h2><div className="mt-3 overflow-x-auto"><table className="w-full min-w-[36rem] text-left text-sm"><thead><tr className="border-b border-line text-xs uppercase tracking-wide text-muted"><th className="py-2 pr-3 font-medium">角色</th><th className="py-2 pr-3 font-medium">任务</th><th className="py-2 pr-3 font-medium">完成</th><th className="py-2 pr-3 font-medium">失败</th><th className="py-2 pr-3 font-medium">审批轮次</th><th className="py-2 pr-3 font-medium">成功率</th><th className="py-2 font-medium">平均耗时</th></tr></thead><tbody className="divide-y divide-line">{agents.map(agent => <tr key={agent.role_id}><td className="py-2.5 pr-3"><span className="grid size-5 place-items-center rounded-full bg-brand/10 text-[10px] font-semibold text-brand-soft">{String(agent.role_name || "?").slice(0, 1)}</span><span className="ml-1">{agent.role_name || `角色 #${agent.role_id}`}</span></td><td className="py-2.5 pr-3">{agent.total}</td><td className="py-2.5 pr-3">{agent.succeeded}</td><td className="py-2.5 pr-3">{agent.failed}</td><td className="py-2.5 pr-3">{agent.reviews || 0}</td><td className="py-2.5 pr-3">{fmtPct(agent.success_rate)}</td><td className="py-3">{fmtDur(agent.avg_duration)}</td></tr>)}</tbody></table></div></Card> : null}
    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen} title="项目设置">
      {settings && <form className="grid gap-4" onSubmit={(event: FormEvent) => { event.preventDefault(); saveSettings.mutate(settings); }}>
        <div className="rounded-xl border border-line bg-elevated p-3"><div className="mb-2 text-sm font-semibold">GitHub 集成</div>
          <div className="grid gap-3">
            <Field label="GitHub 仓库" hint="默认读取本地 git origin remote；可手动修改。"><input className={inputClass} value={settings.github_repo || ""} onChange={e => setSettings({ ...settings, github_repo: e.target.value })} placeholder="owner/repo" /></Field>
            <Field label="自动处理角色" hint="自动创建的 GitHub 任务默认指派给该角色；可不选，稍后手动指派。"><select className={inputClass} value={settings.github_role_id ?? ""} onChange={e => setSettings({ ...settings, github_role_id: e.target.value ? Number(e.target.value) : null })}><option value="">不自动指派</option>{roles.data?.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select></Field>
            <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={!!settings.github_auto_issues} onChange={e => setSettings({ ...settings, github_auto_issues: e.target.checked })} />自动处理 Issue</label>
            <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={!!settings.github_auto_prs} onChange={e => setSettings({ ...settings, github_auto_prs: e.target.checked })} />自动处理 PR</label>
            <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={!!settings.github_auto_security} onChange={e => setSettings({ ...settings, github_auto_security: e.target.checked })} />自动处理安全告警</label>
          </div>
        </div>
        <MutationError value={saveSettings.error} /><div className="flex justify-end"><Button variant="primary" disabled={saveSettings.isPending}>保存设置</Button></div>
      </form>}
    </Dialog>
    <NewTaskDialog open={createOpen} onOpenChange={setCreateOpen} initialProjectID={id} />
  </>;
}
