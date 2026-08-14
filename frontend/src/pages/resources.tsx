import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, CirclePlus, Copy, Download, FlaskConical, FolderKanban, MessagesSquare, Pencil, RefreshCcw, RotateCcw, Search, Trash2 } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { DirectoryPicker } from "../components/directory-picker";
import { PageHeader } from "../components/shell";
import { Badge, Button, Card, Dialog, Empty, Field, inputClass, Spinner, useToast } from "../components/ui";
import { api, keys } from "../lib/api";
import { STATUS_LABEL, ST_COLOR, dependencyInfo, fmtDur, fmtPct } from "../lib/taskmeta";
import { NewTaskDialog, TaskStatus } from "./tasks";
import type { DailyCount, Project, ProjectStats, ProvisionInfo, Role, RoleConfig, RoleProjectStat, RoleStats, RoleStudioDraft, RoleStudioMessage, RoleStudioResult, RuntimeDescriptor, RuntimeField, Skill, StatusCount, Task } from "../types";

function MutationError({ value }: { value: unknown }) {
  return value instanceof Error ? <p role="alert" className="text-sm text-danger">{value.message}</p> : null;
}

export function ProjectDetailPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const project = useQuery({ queryKey: [...keys.projects, id], queryFn: () => api<Project[]>("/projects").then(list => list.find(item => item.id === id)) });
  const stats = useQuery({ queryKey: ["stats", "project", id], queryFn: () => api<ProjectStats>(`/stats/project/${id}`) });
  const tasks = useQuery({ queryKey: ["tasks", "project", id], queryFn: () => api<Task[]>(`/tasks?project_id=${id}`) });
  const [createOpen, setCreateOpen] = useState(false);
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
    mutationFn: ({ taskID, body }: { taskID: number; body: Record<string, unknown> }) => api(`/tasks/${taskID}`, { method: "PATCH", body }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["tasks", "project", id] }); qc.invalidateQueries({ queryKey: keys.tasks }); },
    onError: error => toast((error as Error).message, "bad")
  });
  const removeTask = useMutation({
    mutationFn: (taskID: number) => api(`/tasks/${taskID}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["tasks", "project", id] }); qc.invalidateQueries({ queryKey: keys.tasks }); },
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
    <PageHeader kicker={`Project #${value.id}`} title={value.name} copy={value.description || value.project_dir || undefined} actions={<>
      <Badge tone={value.status === "active" ? "good" : "neutral"}>{value.status === "active" ? "进行中" : "已归档"}</Badge>{value.is_git && <Badge tone="info">Git</Badge>}
      <Button variant="ghost" onClick={() => navigate("/projects")}>返回</Button>
      <Button variant="primary" onClick={() => setCreateOpen(true)}><CirclePlus size={16} />新建任务</Button>
    </>} />
    {value.description ? <div className="detail-desc mt-1">{value.description}</div> : null}
    {stat ? <div className="mt-5 grid gap-5 lg:grid-cols-[auto_minmax(0,1fr)]">
      <div className="ring" style={{ background: `conic-gradient(var(--brand) ${Math.round(Math.min(100, stat.progress || 0) * 3.6)}deg, color-mix(in srgb, var(--ink) 9%, transparent) 0)` }}>
        <div className="ring-inner"><b>{fmtPct(stat.progress || 0)}</b><span>完成度</span></div>
      </div>
      <div className="grid content-start gap-3">
        <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
          {([["进行中", stat.in_flight || 0, "var(--st-running)"], ["待审批", review?.count || 0, "var(--st-review)"], ["完成", stat.succeeded, "var(--st-done)"], ["失败", stat.failed, "var(--st-failed)"], ["实现任务", implementations.length, "var(--fg-muted)"], ["合并任务", merges.length, "var(--merge-accent)"]] as Array<[string, number, string]>).map(([label, num, color]) => <div key={label} className="stat-chip" style={{ "--metric-color": color } as React.CSSProperties}><span className="sc-dot" style={{ background: color }} /><b>{num}</b><span className="sc-label">{label}</span></div>)}
        </div>
        <div className="text-xs font-semibold uppercase tracking-wide text-faint">近 14 天完成</div>
        <DailyChart daily={stat.daily || []} days={14} />
      </div>
    </div> : null}
    <Card className="mt-6"><div className="mb-4 flex items-center"><div><h2 className="font-semibold">任务</h2><p className="mt-1 text-sm text-muted">待执行任务可拖动或用箭头调整顺序，默认按创建时间。</p></div><span className="ml-auto text-sm text-muted">{implementations.length} 个实现 · {merges.length} 个合并</span></div>
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
              {task.status === "queued" && <Button size="sm" variant="ghost" title="重试" onClick={() => patch.mutate({ taskID: task.id, body: { status: "queued" } })}><RotateCcw size={13} /></Button>}
              <Button size="sm" variant="danger" title="删除任务" onClick={() => confirm(`删除任务 #${task.id}？`) && removeTask.mutate(task.id)}><Trash2 size={13} /></Button>
            </div>
          </div>;
        })}
      </div> : <Empty title="还没有任务" copy="创建任务并绑定此项目，执行顺序会显示在这里。" action={<Button size="sm" variant="primary" onClick={() => setCreateOpen(true)}><CirclePlus size={15} />派活</Button>} />}
      {merges.length ? <><h3 className="mb-2 mt-6 text-sm font-semibold text-muted">代码合并 {merges.length}</h3><div className="grid gap-2">{merges.map(task => <Link key={task.id} to={`/tasks/${task.id}`} className="flex items-center gap-2 rounded-xl border border-line bg-elevated px-4 py-3"><span className="chip merge">合并 #{task.merge_of}</span><span className="min-w-0 flex-1 truncate text-sm font-medium hover:text-brand-soft">{task.title}</span><TaskStatus status={task.status} /></Link>)}</div></> : null}
    </Card>
    {agents.length ? <Card className="mt-6"><h2 className="font-semibold">成员统计</h2><div className="mt-4 overflow-x-auto"><table className="w-full min-w-[36rem] text-left text-sm"><thead><tr className="border-b border-line text-xs uppercase tracking-wide text-muted"><th className="py-2 pr-4 font-medium">角色</th><th className="py-2 pr-4 font-medium">任务</th><th className="py-2 pr-4 font-medium">完成</th><th className="py-2 pr-4 font-medium">失败</th><th className="py-2 pr-4 font-medium">审批轮次</th><th className="py-2 pr-4 font-medium">成功率</th><th className="py-2 font-medium">平均耗时</th></tr></thead><tbody className="divide-y divide-line">{agents.map(agent => <tr key={agent.role_id}><td className="py-3 pr-4"><span className="grid size-5 place-items-center rounded-full bg-brand/10 text-[10px] font-semibold text-brand-soft">{String(agent.role_name || "?").slice(0, 1)}</span><span className="ml-1">{agent.role_name || `角色 #${agent.role_id}`}</span></td><td className="py-3 pr-4">{agent.total}</td><td className="py-3 pr-4">{agent.succeeded}</td><td className="py-3 pr-4">{agent.failed}</td><td className="py-3 pr-4">{agent.reviews || 0}</td><td className="py-3 pr-4">{fmtPct(agent.success_rate)}</td><td className="py-3">{fmtDur(agent.avg_duration)}</td></tr>)}</tbody></table></div></Card> : null}
    <NewTaskDialog open={createOpen} onOpenChange={setCreateOpen} initialProjectID={id} />
  </>;
}

function DailyChart({ daily, days }: { daily: DailyCount[]; days: number }) {
  const todayKey = new Date().toISOString().slice(0, 10);
  const map = useMemo(() => {
    const out: Record<string, number> = {};
    for (const item of daily || []) out[item.date] = item.count;
    return out;
  }, [daily]);
  const max = Math.max(1, ...Object.values(map));
  const cols = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const key = date.toISOString().slice(0, 10);
    const count = map[key] || 0;
    const today = key === todayKey;
    cols.push(<div key={key} className={`bc-col ${today ? "today" : ""}`} title={`${key}: ${count} 个完成`}>
      <div className="bc-bar" style={{ height: `${Math.round(count / max * 100)}%`, opacity: count === 0 ? 0.22 : undefined }} />
      <div className="bc-day">{i % 2 === 0 ? key.slice(5) : ""}</div>
    </div>);
  }
  return <div className="bar-chart">{cols}</div>;
}

function StatusBarHTML({ counts }: { counts: StatusCount[] }) {
  const order = ["queued", "claimed", "running", "awaiting_review", "succeeded", "failed", "cancelled"];
  const total = (counts || []).reduce((sum, item) => sum + item.count, 0);
  if (!total) return <div className="status-bar" />;
  return <div className="status-bar">{[...(counts || [])].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status)).filter(item => item.count > 0).map(item => <div key={item.status} className="sb-seg" title={`${STATUS_LABEL[item.status] || item.status}: ${item.count}`} style={{ width: `${item.count / total * 100}%`, background: ST_COLOR[item.status] }} />)}</div>;
}

export function ProjectsPage() {
  const query = useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/projects") });
  const tasks = useQuery({ queryKey: keys.tasks, queryFn: () => api<Task[]>("/tasks") });
  const qc = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Partial<Project> | null>(null);
  const [dirOpen, setDirOpen] = useState(false);
  const save = useMutation({
    mutationFn: (value: Partial<Project>) => value.id
      ? api<Project>(`/projects/${value.id}`, { method: "PATCH", revision: value.revision, body: { name: value.name, description: value.description, project_dir: value.project_dir, status: value.status } })
      : api<Project>("/projects", { method: "POST", body: value }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: keys.projects }); setEditing(null); toast("项目已保存"); }
  });
  const remove = useMutation({ mutationFn: (value: Project) => api<void>(`/projects/${value.id}`, { method: "DELETE", revision: value.revision }), onSuccess: () => qc.invalidateQueries({ queryKey: keys.projects }) });
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return query.data || [];
    return (query.data || []).filter(project => project.name.toLowerCase().includes(q) || (project.description || "").toLowerCase().includes(q));
  }, [query.data, search]);
  return <>
    <PageHeader kicker="Workspace boundaries" title="项目" copy="项目定义代码目录、隔离边界与工作流归属。" actions={<Button variant="primary" onClick={() => setEditing({ status: "active" })}><CirclePlus size={17} />新建项目</Button>} />
    <Card className="mb-5 flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
      <span className="flex items-center gap-2 px-2 text-sm text-muted"><Search size={16} />搜索</span>
      <input className={inputClass + " sm:w-64"} placeholder="搜索项目…" value={search} onChange={e => setSearch(e.target.value)} aria-label="搜索项目" />
      <span className="text-sm text-muted sm:ml-auto">{visible.length} 个项目</span>
    </Card>
    {query.isLoading ? <Spinner /> : visible.length ? <div className="grid gap-4 lg:grid-cols-2">{visible.map(project => {
      const ts = (tasks.data || []).filter(t => t.project_id === project.id);
      const source = ts.filter(t => t.merge_of == null);
      const merges = ts.filter(t => t.merge_of != null);
      const done = source.filter(t => t.status === "succeeded").length;
      const pct = source.length ? Math.round(done / source.length * 100) : 0;
      const roles = new Set(ts.map(t => t.role_name).filter(Boolean));
      return <Link key={project.id} to={`/projects/${project.id}`} className="project-card rounded-2xl border border-line bg-surface p-5 shadow-card transition hover:border-brand/35">
        <div className="flex items-start gap-3">
          <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{project.name}</h2>{project.is_git ? <span className="chip git-chip" title="git 仓库，任务将获得独立 worktree">git</span> : <span className="chip" title="非 git 仓库，任务直接在项目目录执行">非 git</span>}<Badge tone={project.status === "active" ? "good" : "neutral"}>{project.status === "active" ? "进行中" : "已归档"}</Badge></div>
          {project.description ? <p className="mt-2 text-sm leading-6 text-muted">{project.description}</p> : null}</div>
          <div className="ml-auto flex gap-1"><Button size="sm" variant="ghost" aria-label={`编辑 ${project.name}`} onClick={e => { e.preventDefault(); setEditing(project); }}><Pencil size={15} /></Button><Button size="sm" variant="danger" aria-label={`删除 ${project.name}`} onClick={e => { e.preventDefault(); if (confirm(`删除项目“${project.name}”？`)) remove.mutate(project); }}><Trash2 size={15} /></Button></div>
        </div>
        <div className="pc-progress mt-3"><div className="pp-bar"><div style={{ width: `${pct}%` }} /></div><span className="pc-pct">{pct}%</span></div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          {project.project_dir ? <code className="max-w-56 truncate" title={project.project_dir}>{project.project_dir}</code> : null}
          <span>{source.length} 任务</span>
          {merges.length ? <span>{merges.length} 合并</span> : null}
          <span>{done} 实现完成</span>
          <span>{roles.size} 角色</span>
          <span className="ml-auto">{formatTime(project.updated_at || project.created_at)}</span>
        </div>
      </Link>;
    })}</div> : <Empty title={search ? "没有匹配的项目" : "还没有项目"} copy={search ? "调整搜索条件。" : "创建项目并绑定代码目录，任务和工作流才有明确的执行边界。"} />}
    <Dialog open={editing !== null} onOpenChange={open => !open && setEditing(null)} title={editing?.id ? "编辑项目" : "新建项目"}>
      {editing && <form className="grid gap-4" onSubmit={(event: FormEvent) => { event.preventDefault(); save.mutate(editing); }}>
        <Field label="名称"><input className={inputClass} required value={editing.name || ""} onChange={e => setEditing({ ...editing, name: e.target.value })} /></Field>
        <Field label="说明"><textarea className={inputClass + " min-h-24 py-3"} value={editing.description || ""} onChange={e => setEditing({ ...editing, description: e.target.value })} /></Field>
        <Field label="代码目录" hint="使用主机上的绝对路径，或浏览选择目录。"><div className="flex gap-2"><input className={inputClass} value={editing.project_dir || ""} onChange={e => setEditing({ ...editing, project_dir: e.target.value })} /><Button type="button" onClick={() => setDirOpen(true)}><FolderKanban size={16} />浏览</Button></div></Field>
        {editing.id && <Field label="状态"><select className={inputClass} value={editing.status} onChange={e => setEditing({ ...editing, status: e.target.value as Project["status"] })}><option value="active">活跃</option><option value="archived">归档</option></select></Field>}
        <MutationError value={save.error} /><div className="flex justify-end"><Button variant="primary" disabled={save.isPending}>保存</Button></div>
      </form>}
    </Dialog>
    <DirectoryPicker open={dirOpen} onOpenChange={setDirOpen} initial={editing?.project_dir} onPick={path => setEditing(current => current ? { ...current, project_dir: path } : current)} />
  </>;
}

function formatTime(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

type RoleDraft = Partial<Role> & { role_config: RoleConfig };

export function RolesPage() {
  const roles = useQuery({ queryKey: keys.roles, queryFn: () => api<Role[]>("/roles") });
  const tasks = useQuery({ queryKey: keys.tasks, queryFn: () => api<Task[]>("/tasks") });
  const runtimes = useQuery({ queryKey: keys.runtimes, queryFn: () => api<RuntimeDescriptor[]>("/runtimes") });
  const skills = useQuery({ queryKey: keys.skills, queryFn: () => api<Skill[]>("/skills") });
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<RoleDraft | null>(null);
  const [detail, setDetail] = useState<Role | null>(null);
  const [studio, setStudio] = useState<{ role?: Role; draft: RoleStudioDraft } | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("name");
  const [view, setView] = useState<"grid" | "table">("grid");
  const selected = runtimes.data?.find(runtime => runtime.id === draft?.runtime_id);
  const visible = useMemo(() => {
    let list = roles.data || [];
    const q = search.trim().toLowerCase();
    if (q) list = list.filter(role => {
      const rc = role.role_config || {};
      return [role.name, role.description, role.runtime_id, rc.model].some(value => String(value || "").toLowerCase().includes(q));
    });
    const copy = [...list];
    switch (sort) {
      case "created": copy.sort((a, b) => b.created_at.localeCompare(a.created_at)); break;
      case "concurrency": copy.sort((a, b) => b.max_concurrency - a.max_concurrency); break;
      case "runtime": copy.sort((a, b) => a.runtime_id.localeCompare(b.runtime_id)); break;
      default: copy.sort((a, b) => a.name.localeCompare(b.name));
    }
    return copy;
  }, [roles.data, search, sort]);
  const save = useMutation({
    mutationFn: (value: RoleDraft) => value.id
      ? api<Role>(`/roles/${value.id}`, { method: "PATCH", revision: value.revision, body: rolePayload(value) })
      : api<Role>("/roles", { method: "POST", body: rolePayload(value) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: keys.roles }); setDraft(null); toast("角色已保存"); }
  });
  const remove = useMutation({ mutationFn: (value: Role) => api<void>(`/roles/${value.id}`, { method: "DELETE", revision: value.revision }), onSuccess: () => qc.invalidateQueries({ queryKey: keys.roles }) });
  const toggle = useMutation({
    mutationFn: (value: Role) => api<Role>(`/roles/${value.id}`, { method: "PATCH", revision: value.revision, body: { enabled: !value.enabled } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: keys.roles }); },
    onError: error => toast((error as Error).message, "bad")
  });
  const duplicate = useMutation({
    mutationFn: (value: Role) => api<Role>("/roles", { method: "POST", body: { ...rolePayload({ ...value, role_config: value.role_config || {} }), name: `${value.name}（副本）` } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: keys.roles }); toast("已复制角色"); },
    onError: error => toast((error as Error).message, "bad")
  });
  const roleStats = useMemo(() => {
    const out = new Map<number, { total: number; inFlight: number; review: number }>();
    for (const task of tasks.data || []) {
      if (!task.role_id) continue;
      const stat = out.get(task.role_id) || { total: 0, inFlight: 0, review: 0 };
      stat.total++;
      if (["queued", "claimed", "running", "awaiting_review"].includes(task.status)) stat.inFlight++;
      if (task.status === "awaiting_review") stat.review++;
      out.set(task.role_id, stat);
    }
    return out;
  }, [tasks.data]);
  return <>
    <PageHeader kicker="Responsibility profiles" title="角色" copy="角色只描述职责与策略；具体命令翻译由 Runtime 承担。" actions={<><Button onClick={() => setStudio({ draft: { name: "", description: "", runtime_id: runtimes.data?.[0]?.id || "pi", max_concurrency: 1, role_config: {} } })}><MessagesSquare size={16} />角色助手</Button><Button variant="primary" onClick={() => setDraft({ runtime_id: runtimes.data?.[0]?.id || "pi", max_concurrency: 1, enabled: true, role_config: {} })}><CirclePlus size={17} />新建角色</Button></>} />
    <Card className="mb-5 flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
      <span className="flex items-center gap-2 px-2 text-sm text-muted"><Search size={16} />搜索</span>
      <input className={inputClass + " sm:w-64"} placeholder="搜索角色…" value={search} onChange={e => setSearch(e.target.value)} aria-label="搜索角色" />
      <select className={inputClass + " sm:w-44"} value={sort} onChange={e => setSort(e.target.value)} aria-label="角色排序"><option value="name">名称 A-Z</option><option value="created">最近创建</option><option value="concurrency">并发：高到低</option><option value="runtime">Runtime</option></select>
      <span className="text-sm text-muted sm:ml-auto">{visible.length} 个角色</span>
      <div className="flex rounded-xl border border-line bg-elevated p-0.5" role="tablist" aria-label="视图切换">
        <button role="tab" aria-selected={view === "grid"} className={`rounded-[10px] px-3 py-1.5 text-sm ${view === "grid" ? "bg-surface font-semibold text-ink shadow-sm" : "text-muted"}`} onClick={() => setView("grid")}>卡片</button>
        <button role="tab" aria-selected={view === "table"} className={`rounded-[10px] px-3 py-1.5 text-sm ${view === "table" ? "bg-surface font-semibold text-ink shadow-sm" : "text-muted"}`} onClick={() => setView("table")}>表格</button>
      </div>
    </Card>
    {roles.isLoading ? <Spinner /> : !visible.length ? <Empty title={search ? "没有匹配的角色" : "还没有角色"} copy={search ? "尝试清除搜索词，查看全部任务角色。" : "先创建承担执行、评审或研究职责的角色。"} action={!search ? <Button size="sm" variant="primary" onClick={() => setDraft({ runtime_id: runtimes.data?.[0]?.id || "pi", max_concurrency: 1, enabled: true, role_config: {} })}>创建角色</Button> : undefined} /> : view === "grid" ? <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">{visible.map(role => {
    const stat = roleStats.get(role.id) || { total: 0, inFlight: 0, review: 0 };
    return <Card key={role.id}>
      <div className="flex items-start gap-3"><div className="min-w-0"><button className="text-left" onClick={() => setDetail(role)}><h2 className="font-semibold hover:text-brand-soft">{role.name}</h2></button><div className="flex flex-wrap items-center gap-2"><Badge tone={role.enabled ? "good" : "neutral"}>{role.enabled ? "启用" : "停用"}</Badge></div><p className="mt-2 min-h-10 text-sm leading-5 text-muted">{role.description || "未设置描述"}</p></div><Button size="sm" variant="ghost" className="ml-auto" aria-label={`编辑 ${role.name}`} onClick={() => setDraft({ ...role, role_config: role.role_config || {} })}><Pencil size={15} /></Button></div>
      <div className="mt-4 flex flex-wrap gap-2"><Badge tone="info">{role.runtime_id}</Badge><span title="默认模型"><Badge>{role.role_config.model || "默认模型"}</Badge></span><span title="同一角色最多同时运行的任务数"><Badge>并发 {role.max_concurrency}</Badge></span></div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted"><span><b>{stat.total}</b> 任务</span><span><b style={{ color: "var(--st-running)" }}>{stat.inFlight}</b> 进行中</span><span><b style={{ color: "var(--st-review)" }}>{stat.review}</b> 待审批</span></div>
      <div className="mt-4 flex flex-wrap gap-2"><Button size="sm" variant="ghost" onClick={() => setDetail(role)}>详情</Button><Button size="sm" variant="ghost" onClick={() => setStudio({ role, draft: { name: role.name, description: role.description, runtime_id: role.runtime_id, max_concurrency: role.max_concurrency, role_config: role.role_config || {} } })}>助手</Button><Button size="sm" variant="ghost" onClick={() => duplicate.mutate(role)}><Copy size={14} />复制</Button><Button size="sm" variant="ghost" onClick={() => toggle.mutate(role)}>{role.enabled ? "停用" : "启用"}</Button><Button size="sm" variant="danger" className="ml-auto" onClick={() => confirm(`删除角色“${role.name}”？`) && remove.mutate(role)}><Trash2 size={14} />删除</Button></div>
    </Card>;
  })}</div> : <Card className="overflow-hidden p-0"><table className="w-full text-sm"><thead><tr className="border-b border-line text-left text-xs text-faint">
    <th className="px-4 py-2.5 font-medium">角色</th><th className="px-4 py-2.5 font-medium">Runtime</th><th className="px-4 py-2.5 font-medium">模型</th><th className="px-4 py-2.5 font-medium">最大并发</th><th className="px-4 py-2.5 font-medium">任务</th><th className="px-4 py-2.5 font-medium">进行中</th><th className="px-4 py-2.5 font-medium">待审批</th><th className="px-4 py-2.5 font-medium">状态</th><th className="px-4 py-2.5 font-medium">操作</th>
  </tr></thead><tbody className="divide-y divide-line">{visible.map(role => { const stat = roleStats.get(role.id) || { total: 0, inFlight: 0, review: 0 }; return <tr key={role.id} className="hover:bg-hover">
    <td className="px-4 py-2.5"><button className="text-left font-medium hover:text-brand-soft" onClick={() => setDetail(role)}>{role.name}</button><div className="mt-0.5 max-w-72 truncate text-xs text-faint">{role.description || "未设置描述"}</div></td>
    <td className="px-4 py-2.5"><Badge tone="info">{role.runtime_id}</Badge></td>
    <td className="px-4 py-2.5 text-muted">{role.role_config.model || "默认"}</td>
    <td className="px-4 py-2.5 text-muted">{role.max_concurrency}</td>
    <td className="px-4 py-2.5 text-muted">{stat.total}</td>
    <td className="px-4 py-2.5 text-muted">{stat.inFlight}</td>
    <td className="px-4 py-2.5 text-muted">{stat.review}</td>
    <td className="px-4 py-2.5"><Badge tone={role.enabled ? "good" : "neutral"}>{role.enabled ? "启用" : "停用"}</Badge></td>
    <td className="px-4 py-2.5"><span className="inline-flex gap-1.5"><Button size="sm" variant="ghost" onClick={() => setDraft({ ...role, role_config: role.role_config || {} })}>编辑</Button><Button size="sm" variant="ghost" onClick={() => duplicate.mutate(role)}>复制</Button><Button size="sm" variant="ghost" onClick={() => toggle.mutate(role)}>{role.enabled ? "停用" : "启用"}</Button><Button size="sm" variant="danger" onClick={() => confirm(`删除角色“${role.name}”？`) && remove.mutate(role)}><Trash2 size={14} />删除</Button></span></td>
  </tr>; })}</tbody></table></Card>}
    <Dialog open={draft !== null} onOpenChange={open => !open && setDraft(null)} title={draft?.id ? "编辑角色" : "新建角色"} wide>
      {draft && <form className="grid gap-5" onSubmit={(event: FormEvent) => { event.preventDefault(); save.mutate(draft); }}>
        <div className="grid gap-4 md:grid-cols-2"><Field label="名称"><input className={inputClass} required value={draft.name || ""} onChange={e => setDraft({ ...draft, name: e.target.value })} /></Field><Field label="Runtime"><select className={inputClass} value={draft.runtime_id} onChange={e => setDraft({ ...draft, runtime_id: e.target.value, role_config: {} })}>{runtimes.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field></div>
        <Field label="职责说明"><textarea className={inputClass + " min-h-24 py-3"} value={draft.description || ""} onChange={e => setDraft({ ...draft, description: e.target.value })} /></Field>
        <div className="grid gap-4 md:grid-cols-2">{selected?.fields.map(field => <RuntimeFieldInput key={field.key} field={resolveRuntimeField(field, draft.role_config, skills.data)} value={field.builtin ? draft.role_config[field.key as keyof RoleConfig] : draft.role_config.custom?.[field.key]} onChange={value => setDraft({ ...draft, role_config: field.builtin ? { ...draft.role_config, [field.key]: value } : { ...draft.role_config, custom: { ...draft.role_config.custom, [field.key]: String(value) } } })} />)}</div>
        <div className="grid gap-4 md:grid-cols-2"><Field label="最大并发"><input className={inputClass} type="number" min="1" value={draft.max_concurrency || 1} onChange={e => setDraft({ ...draft, max_concurrency: Number(e.target.value) })} /></Field><label className="mt-7 flex min-h-11 items-center gap-3 rounded-xl border border-line bg-elevated px-3 text-sm"><input type="checkbox" checked={draft.enabled ?? true} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />启用角色</label></div>
        <MutationError value={save.error} /><div className="flex justify-end"><Button variant="primary" disabled={save.isPending}>保存角色</Button></div>
      </form>}
    </Dialog>
    {detail && <RoleDetailDialog role={detail} onClose={() => setDetail(null)} />}
    {studio && <RoleStudioDialog initial={studio} onClose={() => setStudio(null)} />}
  </>;
}

function RoleDetailDialog({ role, onClose }: { role: Role; onClose(): void }) {
  const stats = useQuery({ queryKey: ["stats", "roles", role.id], queryFn: () => api<RoleStats>(`/stats/roles/${role.id}`) });
  const recent = useQuery({ queryKey: ["tasks", "role", role.id], queryFn: () => api<Task[]>(`/tasks?role_id=${role.id}&limit=10`) });
  const stat = stats.data;
  const metrics: Array<[string, number | string]> = [
    ["总任务", stat?.total ?? 0], ["进行中", stat?.in_flight ?? 0], ["完成", stat?.succeeded ?? 0], ["失败", stat?.failed ?? 0], ["取消", stat?.cancelled ?? 0], ["待审批", stat?.reviews ?? 0], ["成功率", stat ? `${Math.round(stat.success_rate)}%` : 0]
  ];
  return <Dialog open onOpenChange={open => !open && onClose()} title={`角色详情 · ${role.name}`} wide>
    <div className="grid gap-5">
      <div className="flex flex-wrap gap-2"><Badge tone="info">{role.runtime_id}</Badge><Badge>并发 {role.max_concurrency}</Badge>{role.role_config.model && <Badge>{role.role_config.model}</Badge>}<Badge tone={role.enabled ? "good" : "neutral"}>{role.enabled ? "启用" : "停用"}</Badge></div>
      {role.description && <p className="text-sm leading-6 text-muted">{role.description}</p>}
      {stats.isLoading ? <Spinner /> : stat ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{metrics.map(([label, num]) => <div key={label} className="rounded-xl border border-line bg-elevated p-3"><div className="text-xs text-muted">{label}</div><div className="mt-1 text-xl font-semibold">{num}</div></div>)}</div> : null}
      {stat?.status_counts?.length ? <div className="grid gap-1.5"><StatusBarHTML counts={stat.status_counts} />{stat.status_counts.map((item: StatusCount) => <div key={item.status} className="flex items-center gap-3 text-sm"><span className="w-20 shrink-0 text-muted">{statusLabelOf(item.status)}</span><div className="h-2 flex-1 overflow-hidden rounded-full bg-elevated"><div className="h-full rounded-full bg-brand/70" style={{ width: `${stat.total ? (item.count / stat.total) * 100 : 0}%` }} /></div><span className="w-8 text-right text-muted">{item.count}</span></div>)}</div> : null}
      {stat?.projects?.length ? <div><h3 className="mb-2 text-sm font-semibold text-muted">项目产出</h3><div className="overflow-x-auto"><table className="w-full min-w-[30rem] text-left text-sm"><thead><tr className="border-b border-line text-xs uppercase tracking-wide text-muted"><th className="py-2 pr-4 font-medium">项目</th><th className="py-2 pr-4 font-medium">总任务</th><th className="py-2 pr-4 font-medium">完成</th><th className="py-2 pr-4 font-medium">失败</th><th className="py-2 font-medium">成功率</th></tr></thead><tbody className="divide-y divide-line">{stat.projects.map((item: RoleProjectStat) => <tr key={item.project_id}><td className="py-3 pr-4">{item.project_name || `项目 #${item.project_id}`}</td><td className="py-3 pr-4">{item.total}</td><td className="py-3 pr-4">{item.succeeded}</td><td className="py-3 pr-4">{item.failed}</td><td className="py-3">{Math.round(item.success_rate)}%</td></tr>)}</tbody></table></div></div> : null}
      {recent.data?.length ? <div><h3 className="mb-2 text-sm font-semibold text-muted">最近任务</h3><div className="grid gap-2">{recent.data.map(task => <Link key={task.id} to={`/tasks/${task.id}`} className="flex items-center gap-2 rounded-xl border border-line bg-elevated px-3 py-2 text-sm hover:border-brand/40"><span className="min-w-0 flex-1 truncate">{task.title}</span><TaskStatus status={task.status} /></Link>)}</div></div> : null}
      <div className="flex justify-end"><Button variant="ghost" onClick={onClose}>关闭</Button></div>
    </div>
  </Dialog>;
}

function RoleStudioDialog({ initial, onClose }: { initial: { role?: Role; draft: RoleStudioDraft }; onClose(): void }) {
  const runtimes = useQuery({ queryKey: keys.runtimes, queryFn: () => api<RuntimeDescriptor[]>("/runtimes") });
  const skills = useQuery({ queryKey: keys.skills, queryFn: () => api<Skill[]>("/skills") });
  const roles = useQuery({ queryKey: keys.roles, queryFn: () => api<Role[]>("/roles") });
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<RoleStudioDraft>(initial.draft);
  const [creatorID, setCreatorID] = useState(0);
  const [tab, setTab] = useState<"chat" | "test">("chat");
  const [chatMsg, setChatMsg] = useState("");
  const [testMsg, setTestMsg] = useState("");
  const [creatorMessages, setCreatorMessages] = useState<RoleStudioMessage[]>([]);
  const [testMessages, setTestMessages] = useState<RoleStudioMessage[]>([]);
  const [testOutput, setTestOutput] = useState("");
  const selected = runtimes.data?.find(runtime => runtime.id === draft.runtime_id);
  const setField = (field: RuntimeField, value: unknown) => setDraft(prev => ({ ...prev, role_config: field.builtin ? { ...prev.role_config, [field.key]: value } : { ...prev.role_config, custom: { ...prev.role_config.custom, [field.key]: String(value) } } }));
  const chat = useMutation({
    mutationFn: () => api<RoleStudioResult>("/role-studio/chat", { method: "POST", body: { creator_role_id: creatorID, draft, message: chatMsg, creator_messages: creatorMessages, test_messages: testMessages } }),
    onSuccess: result => {
      setCreatorMessages(prev => [...prev, { role: "user", content: chatMsg }, { role: "assistant", content: result.message }]);
      if (result.draft) { setDraft(result.draft); toast("已应用助手草稿"); }
      setChatMsg("");
    },
    onError: error => toast((error as Error).message, "bad")
  });
  const test = useMutation({
    mutationFn: () => api<{ output: string }>("/role-studio/test", { method: "POST", body: { draft, message: testMsg, test_messages: testMessages } }),
    onSuccess: result => { setTestMessages(prev => [...prev, { role: "user", content: testMsg }]); setTestOutput(result.output); setTestMsg(""); },
    onError: error => toast((error as Error).message, "bad")
  });
  const save = useMutation({
    mutationFn: () => initial.role
      ? api<Role>(`/roles/${initial.role.id}`, { method: "PATCH", revision: initial.role.revision, body: { name: draft.name, description: draft.description, runtime_id: draft.runtime_id, role_config: draft.role_config, max_concurrency: draft.max_concurrency, enabled: initial.role.enabled } })
      : api<Role>("/roles", { method: "POST", body: { name: draft.name, description: draft.description, runtime_id: draft.runtime_id, role_config: draft.role_config, max_concurrency: draft.max_concurrency, enabled: true } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: keys.roles }); toast("角色已保存"); onClose(); },
    onError: error => toast((error as Error).message, "bad")
  });
  const tabClass = (active: boolean) => `flex-1 rounded-lg px-3 py-2 text-sm font-medium ${active ? "bg-brand/15 text-brand-soft" : "text-muted hover:bg-hover"}`;
  return <Dialog open onOpenChange={open => !open && onClose()} title={`角色助手 · ${initial.role?.name || "新角色"}`} description="向创建助手描述职责，或测试草稿的实际表现；助手可改写草稿。">
    <div className="grid gap-5">
      <div className="grid gap-4 md:grid-cols-2"><Field label="名称"><input className={inputClass} required value={draft.name || ""} onChange={e => setDraft({ ...draft, name: e.target.value })} /></Field><Field label="Runtime"><select className={inputClass} value={draft.runtime_id} onChange={e => setDraft({ ...draft, runtime_id: e.target.value, role_config: {} })}>{runtimes.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field></div>
      <Field label="职责说明"><textarea className={inputClass + " min-h-20 py-3"} value={draft.description || ""} onChange={e => setDraft({ ...draft, description: e.target.value })} /></Field>
      <div className="grid gap-4 md:grid-cols-2">{selected?.fields.map(field => <RuntimeFieldInput key={field.key} field={resolveRuntimeField(field, draft.role_config, skills.data)} value={field.builtin ? draft.role_config[field.key as keyof RoleConfig] : draft.role_config.custom?.[field.key]} onChange={value => setField(field, value)} />)}</div>
      <div className="grid gap-4 md:grid-cols-2"><Field label="最大并发"><input className={inputClass} type="number" min="1" value={draft.max_concurrency || 1} onChange={e => setDraft({ ...draft, max_concurrency: Number(e.target.value) })} /></Field><Field label="创建助手角色" hint="角色助手由哪个已启用角色驱动"><select className={inputClass} value={creatorID} onChange={e => setCreatorID(Number(e.target.value))}><option value={0}>自动选择</option>{roles.data?.filter(role => role.enabled).map(role => <option key={role.id} value={role.id}>{role.name} · {role.runtime_id}</option>)}</select></Field></div>
      <div className="flex gap-1 rounded-xl border border-line p-1"><button type="button" className={tabClass(tab === "chat")} onClick={() => setTab("chat")}><MessagesSquare size={14} className="mr-1 inline" />助手对话</button><button type="button" className={tabClass(tab === "test")} onClick={() => setTab("test")}><FlaskConical size={14} className="mr-1 inline" />测试</button></div>
      {tab === "chat" ? <div className="grid gap-3">
        <div className="max-h-52 overflow-auto rounded-xl bg-elevated p-3 text-sm">{creatorMessages.length ? creatorMessages.map((msg, index) => <div key={index} className="mb-2"><b className="text-ink">{msg.role === "user" ? "你" : "助手"}</b><p className="whitespace-pre-wrap text-muted">{msg.content}</p></div>) : <p className="text-muted">向助手描述你想创建的角色，或要求它检查/修改当前草稿。回复可能附带新的角色草稿。</p>}</div>
        <div className="flex gap-2"><textarea className={inputClass + " min-h-16 py-3"} value={chatMsg} onChange={e => setChatMsg(e.target.value)} placeholder="例如：帮我检查当前草稿，并补充适合资深后端工程师的系统提示词…" /><Button variant="primary" disabled={!chatMsg.trim() || chat.isPending} onClick={() => chat.mutate()}>发送</Button></div>
      </div> : <div className="grid gap-3">
        <div className="max-h-32 overflow-auto rounded-xl bg-elevated p-3 text-sm">{testMessages.map((msg, index) => <div key={index} className="mb-2"><b className="text-ink">{msg.role === "user" ? "测试输入" : "助手"}</b><p className="whitespace-pre-wrap text-muted">{msg.content}</p></div>)}</div>
        <div className="flex gap-2"><input className={inputClass} value={testMsg} onChange={e => setTestMsg(e.target.value)} placeholder="输入测试消息，模拟角色实际执行…" onKeyDown={e => { if (e.key === "Enter" && testMsg.trim() && !test.isPending) test.mutate(); }} /><Button disabled={!testMsg.trim() || test.isPending} onClick={() => test.mutate()}>运行测试</Button></div>
        {test.isPending ? <Spinner label="测试执行中" /> : testOutput ? <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded-xl bg-[#080d15] p-4 text-xs leading-5 text-slate-200">{testOutput}</pre> : null}
      </div>}
      <MutationError value={save.error} />
      <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>关闭</Button><Button variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>保存角色</Button></div>
    </div>
  </Dialog>;
}

function statusLabelOf(status: string): string {
  const map: Record<string, string> = { queued: "排队", claimed: "领取", running: "执行中", awaiting_review: "待审批", succeeded: "完成", failed: "失败", cancelled: "取消" };
  return map[status] || status;
}

function resolveRuntimeField(field: RuntimeField, config: RoleConfig, skills?: Skill[]): RuntimeField {
  if (field.source === "skills") return { ...field, suggestions: skills?.map(skill => skill.dir) || [] };
  if (field.key === "thinking" && config.model && field.thinking_options_by_model?.[config.model]) {
    return { ...field, options: ["", ...field.thinking_options_by_model[config.model].filter(option => option !== "")] };
  }
  return field;
}

function RuntimeFieldInput({ field, value, onChange }: { field: RuntimeField; value: unknown; onChange(value: unknown): void }) {
  const effectiveValue = value === undefined ? field.default : value;
  const text = Array.isArray(effectiveValue) ? effectiveValue.join("\n") : field.type === "env" && effectiveValue && typeof effectiveValue === "object" ? Object.entries(effectiveValue).map(([key, item]) => `${key}=${item}`).join("\n") : typeof effectiveValue === "string" ? effectiveValue : "";
  if (field.type === "list" && field.suggestions?.length) {
    const selected = new Set(Array.isArray(effectiveValue) ? effectiveValue : text.split(/[\n,]/).map(item => item.trim()).filter(Boolean));
    const toggle = (option: string, checked: boolean) => {
      const next = new Set(selected);
      if (checked) next.add(option); else next.delete(option);
      const values = field.suggestions?.filter(item => next.has(item)) || [];
      onChange(field.builtin ? values : values.join(","));
    };
    return <fieldset className="grid gap-2 rounded-xl border border-line bg-elevated p-3"><legend className="px-1 text-sm font-medium text-ink">{field.label}</legend><div className="grid max-h-44 gap-2 overflow-auto">{field.suggestions.map(option => <label key={option} className="flex min-h-9 items-center gap-2 text-xs font-normal text-ink"><input type="checkbox" checked={selected.has(option)} onChange={event => toggle(option, event.target.checked)} /><span className="min-w-0 break-all">{option}</span></label>)}</div>{field.help && <p className="text-xs leading-5 text-muted">{field.help}</p>}</fieldset>;
  }
  if (field.type === "textarea" || field.type === "list" || field.type === "env" || field.key === "extra_args") return <Field label={field.label} hint={field.help}><textarea className={inputClass + " min-h-24 py-3"} placeholder={field.placeholder} value={text} onChange={e => {
    if (!field.builtin) onChange(e.target.value);
    else if (field.type === "list" || field.key === "extra_args") onChange(e.target.value.split("\n").map(v => v.trim()).filter(Boolean));
    else if (field.type === "env") onChange(Object.fromEntries(e.target.value.split("\n").map(line => line.split("=", 2)).filter(parts => parts[0]).map(([key, item = ""]) => [key.trim(), item])));
    else onChange(e.target.value);
  }} /></Field>;
  if (field.type === "select") return <Field label={field.label} hint={field.help}><select className={inputClass} value={text} onChange={e => onChange(e.target.value)}><option value="">使用 Runtime 默认值</option>{field.options?.map(option => <option key={option}>{option}</option>)}</select></Field>;
  return <Field label={field.label} hint={field.help}><input className={inputClass} list={`runtime-${field.key}`} placeholder={field.placeholder} value={text} onChange={e => onChange(e.target.value)} />{field.suggestions?.length ? <datalist id={`runtime-${field.key}`}>{field.suggestions.map(option => <option key={option} value={option} />)}</datalist> : null}</Field>;
}

function rolePayload(value: RoleDraft) {
  return { name: value.name, description: value.description || "", runtime_id: value.runtime_id, role_config: value.role_config, max_concurrency: value.max_concurrency || 1, enabled: value.enabled ?? true };
}

export function RuntimesPage() {
  const runtimes = useQuery({ queryKey: keys.runtimes, queryFn: () => api<RuntimeDescriptor[]>("/runtimes") });
  const provisioning = useQuery({ queryKey: keys.provisioning, queryFn: () => api<ProvisionInfo[]>("/runtimes/provisioning") });
  const qc = useQueryClient();
  const toast = useToast();
  const [installing, setInstalling] = useState<string | null>(null);
  const refresh = useMutation({ mutationFn: () => api<RuntimeDescriptor[]>("/runtimes/refresh", { method: "POST" }), onSuccess: () => qc.invalidateQueries({ queryKey: keys.runtimes }) });
  const install = useMutation({
    mutationFn: (runtime_id: string) => api("/runtimes/install", { method: "POST", body: { runtime_id } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: keys.provisioning }); },
    onError: error => toast((error as Error).message, "bad")
  });
  const startInstall = (runtimeID: string) => {
    setInstalling(runtimeID);
    install.mutate(runtimeID);
  };
  const byID = useMemo(() => new Map(provisioning.data?.map(item => [item.id, item])), [provisioning.data]);
  const createRole = useMutation({
    mutationFn: (provision: ProvisionInfo) => api<Role>("/roles", { method: "POST", body: { name: provision.name, description: `基于 ${provision.name} CLI 的默认角色`, runtime_id: provision.id, max_concurrency: 1, enabled: true, role_config: {} } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: keys.roles }); toast("已创建角色，可在角色页继续定制"); },
    onError: error => toast((error as Error).message, "bad")
  });
  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制");
    } catch {
      toast("复制失败", "bad");
    }
  };
  return <>
    <PageHeader kicker="Execution providers" title="Runtime" copy="Runtime 目录统一声明批处理、结构化会话、技能与安装能力。" actions={<Button onClick={() => refresh.mutate()} disabled={refresh.isPending}><RefreshCcw size={16} />刷新模型与健康状态</Button>} />
    <div className="mb-4 text-sm text-muted">已安装 {provisioning.data?.filter(p => p.installed).length || 0}/{provisioning.data?.length || 0}</div>
    {runtimes.isLoading ? <Spinner /> : <div className="grid gap-4 lg:grid-cols-2">{runtimes.data?.map(runtime => { const provision = byID.get(runtime.id); return <Card key={runtime.id}>
      <div className="flex items-start gap-3"><div><div className="flex items-center gap-2"><h2 className="font-semibold">{runtime.name}</h2><Badge tone={runtime.healthy ? "good" : "bad"}>{runtime.healthy ? "可用" : "不可用"}</Badge></div><a className="mt-1 block text-xs text-brand-soft hover:underline" href={runtime.docs} target="_blank" rel="noreferrer">官方文档 ↗</a></div>{provision?.version ? <span className="ml-auto text-sm text-faint">{provision.version}</span> : null}</div>
      {runtime.health && <p className="mt-3 text-sm text-muted">{runtime.health}</p>}
      {provision ? <div className="mt-3 rounded-xl border border-line bg-elevated px-3 py-2 text-xs">
        {provision.installed
          ? provision.login
            ? <p className="text-success">已检测到登录凭据 ✓</p>
            : <p className="text-warning">{provision.login_hint || "请在服务器终端完成登录"}</p>
          : <p className="font-mono text-muted" title="官方安装命令">$ {provision.install_cmd || "（请参考官方文档）"}</p>}
      </div> : null}
      <div className="mt-4 flex flex-wrap gap-2">{runtime.capabilities.map(cap => <Badge key={cap} tone="info">{cap}</Badge>)}</div>
      <div className="mt-4 text-xs text-muted">{runtime.models?.length || 0} 个可用模型 · {runtime.fields.length} 个配置字段</div>
      <div className="mt-4 flex flex-wrap gap-2">
        {provision && !provision.installed ? <Button size="sm" variant="primary" onClick={() => startInstall(runtime.id)}><Download size={15} />安装</Button> : null}
        {provision && provision.installed ? <Button size="sm" onClick={() => startInstall(runtime.id)}><RefreshCcw size={14} />重装/更新</Button> : null}
        {provision && provision.installed && provision.login_hint ? <Button size="sm" variant="ghost" onClick={() => void copyText(provision.login_hint)}><Copy size={14} />复制登录指引</Button> : null}
        {provision && provision.installed ? <Button size="sm" variant="ghost" onClick={() => { const name = prompt(`创建基于 ${runtime.name} 的默认角色名称`, runtime.name); if (name) createRole.mutate({ ...provision, name }); }}><CirclePlus size={14} />创建默认角色</Button> : null}
      </div>
    </Card>; })}</div>}
    {installing && <InstallModal runtimeID={installing} onClose={() => setInstalling(null)} />}
  </>;
}

function InstallModal({ runtimeID, onClose }: { runtimeID: string; onClose(): void }) {
  const runtimes = useQuery({ queryKey: keys.runtimes, queryFn: () => api<RuntimeDescriptor[]>("/runtimes") });
  const [lines, setLines] = useState<string[]>(["正在启动安装..."]);
  useEffect(() => {
    const source = new EventSource("/api/v1/events");
    const receive = (event: MessageEvent) => {
      try {
        const envelope = JSON.parse(event.data);
        const payload = envelope?.payload;
        if (payload?.runtime_id !== runtimeID) return;
        const line = String(payload?.line ?? "");
        setLines(prev => [...prev, line]);
      } catch { /* ignore malformed provision events */ }
    };
    source.addEventListener("provision", receive);
    source.onerror = () => { /* 事件流断开由页面级 useEventStream 恢复；此处仅接收安装输出 */ };
    return () => source.close();
  }, [runtimeID]);
  const name = runtimes.data?.find(item => item.id === runtimeID)?.name || runtimeID;
  return <Dialog open onOpenChange={open => !open && onClose()} title={`安装 ${name}`} description="命令回显与执行输出由服务端经 SSE provision 事件实时推送。">
    <div className="rounded-xl border border-line bg-[#060a13] p-3">
      <div className="log-lines max-h-96" style={{ border: "none", padding: "0 4px", maxHeight: "24rem" }}>
        {lines.map((line, index) => <div key={index} className="line"><span className="ts" /><span className={line.startsWith("$") ? "c sys" : "c out"}>{line}</span></div>)}
      </div>
    </div>
    <div className="mt-4 flex justify-end"><Button onClick={onClose}>关闭</Button></div>
  </Dialog>;
}
