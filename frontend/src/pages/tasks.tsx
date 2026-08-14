import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CirclePlus, Copy, FolderKanban, GitBranch, ListFilter, ListTree, Play, RotateCcw, Save, Square, TerminalSquare, X } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { PageHeader } from "../components/shell";
import { TaskTerminal } from "../components/terminal";
import { Badge, Button, Card, Dialog, Empty, Field, inputClass, Spinner, useToast } from "../components/ui";
import { api, keys } from "../lib/api";
import type { Artifact, OverviewStats, Project, Role, Task, TaskLog, TaskLogPage, TaskTemplate, WorkspaceStatus } from "../types";

const statusLabel: Record<string, string> = { queued: "排队", claimed: "领取", running: "执行中", awaiting_review: "待审批", succeeded: "完成", failed: "失败", cancelled: "取消" };
const statusTone: Record<string, "neutral" | "good" | "warn" | "bad" | "info"> = { queued: "neutral", claimed: "info", running: "info", awaiting_review: "warn", succeeded: "good", failed: "bad", cancelled: "neutral" };

export function TaskStatus({ status }: { status: string }) {
  return <Badge tone={statusTone[status] || "neutral"}>{statusLabel[status] || status}</Badge>;
}

function useTasks(query = "") {
  return useQuery({ queryKey: [...keys.tasks, query], queryFn: () => api<Task[]>(`/tasks${query}`), refetchInterval: 15_000 });
}

function TaskRow({ task }: { task: Task }) {
  return <Link to={`/tasks/${task.id}`} className="group grid gap-3 rounded-xl border border-line bg-elevated p-4 transition hover:border-brand/35 hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus sm:grid-cols-[1fr_auto]">
    <div className="min-w-0"><div className="flex items-center gap-2"><span className="text-xs text-faint">#{task.id}</span><h3 className="truncate font-medium text-ink group-hover:text-brand-soft">{task.title}</h3></div><div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">{task.project_name && <span>{task.project_name}</span>}{task.role_name && <span>· {task.role_name}</span>}<span>· {formatTime(task.updated_at)}</span></div></div>
    <div className="flex items-center gap-2"><TaskStatus status={task.status} />{task.review_rounds > 0 && <Badge>{task.review_rounds} 轮</Badge>}</div>
  </Link>;
}

export function DashboardPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const stats = useQuery({ queryKey: keys.stats, queryFn: () => api<OverviewStats>("/stats/overview") });
  const tasks = useTasks("?limit=40");
  const projects = useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/projects") });
  const active = tasks.data?.filter(task => ["queued", "claimed", "running", "awaiting_review"].includes(task.status)) || [];
  const metrics = [
    ["进行中", stats.data?.in_flight || 0], ["待审批", stats.data?.reviews || 0], ["已完成", stats.data?.succeeded || 0], ["成功率", `${Math.round(stats.data?.success_rate || 0)}%`]
  ];
  return <>
    <PageHeader kicker="Operations overview" title="工作台" copy="从审批、执行和项目进展开始，所有状态都由持久事件流同步。" actions={<Button variant="primary" onClick={() => setCreateOpen(true)}><CirclePlus size={17} />新建任务</Button>} />
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{metrics.map(([label, value]) => <Card key={label as string}><div className="text-sm text-muted">{label}</div><div className="mt-3 text-3xl font-semibold tracking-tight text-ink">{value}</div></Card>)}</div>
    <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(18rem,.75fr)]">
      <Card><div className="mb-4 flex items-center"><div><h2 className="font-semibold">待办与执行</h2><p className="mt-1 text-sm text-muted">先处理审批，再跟进运行任务</p></div><Link to="/board" className="ml-auto text-sm text-brand-soft hover:underline">完整任务板 →</Link></div>
        {tasks.isLoading ? <Spinner /> : active.length ? <div className="grid gap-2">{active.slice(0, 8).map(task => <TaskRow key={task.id} task={task} />)}</div> : <Empty title="当前没有待办" copy="创建一个任务，或让 Workflow Plan 实例化任务节点。" />}
      </Card>
      <Card><div className="mb-4 flex items-center"><div><h2 className="font-semibold">活跃项目</h2><p className="mt-1 text-sm text-muted">工作目标与本地目录</p></div><Link to="/projects" className="ml-auto text-sm text-brand-soft">管理 →</Link></div>
        {projects.isLoading ? <Spinner /> : <div className="grid gap-2">{projects.data?.filter(project => project.status === "active").slice(0, 6).map(project => <Link to={`/projects/${project.id}`} key={project.id} className="flex items-center gap-3 rounded-xl border border-line bg-elevated p-3 hover:bg-hover"><span className="grid size-9 place-items-center rounded-lg bg-brand/10 text-brand-soft"><FolderKanban size={17} /></span><span className="min-w-0"><b className="block truncate text-sm">{project.name}</b><small className="block truncate text-muted">{project.project_dir}</small></span>{project.is_git && <Badge tone="good">git</Badge>}</Link>)}</div>}
      </Card>
    </div>
    <NewTaskDialog open={createOpen} onOpenChange={setCreateOpen} />
  </>;
}

export function BoardPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const [status, setStatus] = useState("");
  const [project, setProject] = useState("");
  const tasks = useTasks();
  const projects = useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/projects") });
  const filtered = useMemo(() => (tasks.data || []).filter(task => (!status || task.status === status) && (!project || String(task.project_id) === project)), [tasks.data, status, project]);
  const columns: Array<[string, string, Task["status"][]]> = [
    ["queued", "待执行", ["queued", "claimed"]], ["running", "执行中", ["running"]], ["awaiting_review", "待审批", ["awaiting_review"]], ["failed", "需处理", ["failed", "cancelled"]]
  ];
  return <>
    <PageHeader kicker="Delivery pipeline" title="任务" copy="任务状态机、依赖交付、审批和代码整合保持确定性。" actions={<Button variant="primary" onClick={() => setCreateOpen(true)}><CirclePlus size={17} />新建任务</Button>} />
    <Card className="mb-5 flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
      <span className="flex items-center gap-2 px-2 text-sm text-muted"><ListFilter size={16} />筛选</span>
      <select className={inputClass + " sm:w-44"} value={project} onChange={event => setProject(event.target.value)} aria-label="按项目筛选"><option value="">全部项目</option>{projects.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <select className={inputClass + " sm:w-40"} value={status} onChange={event => setStatus(event.target.value)} aria-label="按状态筛选"><option value="">全部状态</option>{Object.entries(statusLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <span className="text-sm text-muted sm:ml-auto">{filtered.length} 个任务</span>
    </Card>
    {tasks.isLoading ? <Spinner /> : <div className="grid gap-4 xl:grid-cols-4">{columns.map(([key, label, statuses]) => <section key={key} className="min-w-0 rounded-2xl border border-line bg-surface/60 p-3"><div className="mb-3 flex items-center px-1"><h2 className="text-sm font-semibold">{label}</h2><Badge tone={statusTone[key]}>{filtered.filter(task => statuses.includes(task.status)).length}</Badge></div><div className="grid gap-2">{filtered.filter(task => statuses.includes(task.status)).map(task => <TaskRow key={task.id} task={task} />)}</div></section>)}</div>}
    <NewTaskDialog open={createOpen} onOpenChange={setCreateOpen} />
  </>;
}

export function HistoryPage() {
  const tasks = useTasks("?limit=300");
  const roles = useQuery({ queryKey: keys.roles, queryFn: () => api<Role[]>("/roles") });
  const qc = useQueryClient();
  const toast = useToast();
  const [roleID, setRoleID] = useState("");
  const [status, setStatus] = useState("");
  const [days, setDays] = useState("");
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const terminal = tasks.data?.filter(task => ["succeeded", "failed", "cancelled"].includes(task.status)) || [];
  const cutoff = days ? Date.now() - Number(days) * 86400_000 : 0;
  const filtered = terminal.filter(task => {
    if (roleID && String(task.role_id) !== roleID) return false;
    if (status && task.status !== status) return false;
    if (cutoff) {
      const at = task.finished_at || task.created_at;
      if (at && new Date(at).getTime() < cutoff) return false;
    }
    return true;
  });
  const toggle = (id: number) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setSelected(prev => {
    const eligible = filtered.filter(task => !task.merge_of).map(task => task.id);
    const allPicked = eligible.every(id => prev.has(id));
    const next = new Set(prev);
    if (allPicked) eligible.forEach(id => next.delete(id)); else eligible.forEach(id => next.add(id));
    return next;
  });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["tasks"] }); qc.invalidateQueries({ queryKey: keys.tasks }); };
  const removeSelected = useMutation({
    mutationFn: async () => { await Promise.all([...selected].map(id => api(`/tasks/${id}`, { method: "DELETE" }))); },
    onSuccess: () => { toast(`已删除 ${selected.size} 条`); setSelected(new Set()); refresh(); },
    onError: error => toast((error as Error).message, "bad")
  });
  const cleanup = useMutation({
    mutationFn: () => api<{ deleted: number }>("/tasks/cleanup", { method: "POST", body: { role_id: roleID ? Number(roleID) : null, before: new Date(cutoff).toISOString() } }),
    onSuccess: data => { toast(`已清理 ${data.deleted} 条历史任务`); setSelected(new Set()); refresh(); },
    onError: error => toast((error as Error).message, "bad")
  });
  return <>
    <PageHeader kicker="Audit history" title="历史" copy="已结算任务及其退出原因、审批轮次和时间。" />
    <Card className="mb-5 flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
      <span className="flex items-center gap-2 px-2 text-sm text-muted"><ListFilter size={16} />筛选</span>
      <select className={inputClass + " sm:w-44"} value={roleID} onChange={event => setRoleID(event.target.value)} aria-label="按角色筛选"><option value="">全部角色</option>{roles.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <select className={inputClass + " sm:w-36"} value={status} onChange={event => setStatus(event.target.value)} aria-label="按状态筛选"><option value="">全部状态</option>{Object.entries(statusLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <select className={inputClass + " sm:w-32"} value={days} onChange={event => setDays(event.target.value)} aria-label="按天数筛选"><option value="">全部时间</option>{["7", "30", "90"].map(day => <option key={day} value={day}>近 {day} 天</option>)}</select>
      <span className="text-sm text-muted sm:ml-auto">{filtered.length} 条</span>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={toggleAll}>全选非合并</Button>
        <Button size="sm" variant="danger" disabled={!selected.size || removeSelected.isPending} onClick={() => confirm(`删除选中的 ${selected.size} 条历史任务？`) && removeSelected.mutate()}>删除选中{selected.size ? `（${selected.size}）` : ""}</Button>
        <Button size="sm" disabled={!days || cleanup.isPending} title={days ? "按当前角色与时间筛选清理" : "请先选择时间范围"} onClick={() => confirm(`清理当前筛选下的历史任务（${days ? `近 ${days} 天` : ""}）？`) && cleanup.mutate()}>清理筛选结果</Button>
      </div>
    </Card>
    {tasks.isLoading ? <Spinner /> : filtered.length ? <Card className="overflow-hidden p-0"><div className="divide-y divide-line">{filtered.map(task => <div key={task.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-hover">
      <input type="checkbox" aria-label={`选择任务 ${task.title}`} checked={selected.has(task.id)} onChange={() => toggle(task.id)} className="size-4 shrink-0 accent-[var(--brand)]" />
      <Link to={`/tasks/${task.id}`} className="group min-w-0 flex-1"><span className="block truncate text-sm font-medium group-hover:text-brand-soft">{task.title}</span><span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted"><span>#{task.id}</span>{task.role_name && <span>{task.role_name}</span>}{task.project_name && <span>· {task.project_name}</span>}<span>· {formatTime(task.finished_at || task.created_at)}</span></span></Link>
      <TaskStatus status={task.status} />{task.review_rounds > 0 && <Badge>{task.review_rounds} 轮</Badge>}<Badge tone={task.perm === "review" ? "warn" : "neutral"}>{task.perm === "review" ? "审批" : "自动"}</Badge>
    </div>)}</div></Card> : <Empty title="没有符合条件的记录" copy="调整筛选条件，或等任务进入终态。" />}
  </>;
}

export function TaskDetailPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const task = useQuery({ queryKey: keys.task(id), queryFn: () => api<Task>(`/tasks/${id}`), refetchInterval: 5000 });
  const logs = useQuery({ queryKey: ["tasks", id, "logs"], queryFn: () => api<TaskLogPage>(`/tasks/${id}/logs?limit=500`), refetchInterval: task.data?.status === "running" ? 1500 : false });
  const [olderLogs, setOlderLogs] = useState<TaskLog[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const allLogs = [...olderLogs, ...(logs.data?.logs || [])];
  const diff = useQuery({ queryKey: ["tasks", id, "diff"], queryFn: () => api<{ stat: string; diff: string; note?: string }>(`/tasks/${id}/diff`), enabled: task.data?.status === "awaiting_review" });
  const artifacts = useQuery({ queryKey: ["tasks", id, "artifacts"], queryFn: () => api<Artifact[]>(`/artifacts?task_id=${id}`) });
  const children = useQuery({ queryKey: ["tasks", id, "children"], queryFn: () => api<Task[]>(`/tasks/${id}/children`) });
  const workspace = useQuery({ queryKey: ["tasks", id, "workspace"], queryFn: () => api<WorkspaceStatus>(`/workspace/${id}`) });
  const roles = useQuery({ queryKey: keys.roles, queryFn: () => api<Role[]>("/roles") });
  const projects = useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/projects") });
  const mutate = useMutation({ mutationFn: (body: Record<string, unknown>) => api<Task>(`/tasks/${id}`, { method: "PATCH", revision: task.data?.revision, body }), onSuccess: value => { queryClient.setQueryData(keys.task(id), value); void queryClient.invalidateQueries({ queryKey: keys.tasks }); toast("任务已更新"); }, onError: error => toast((error as Error).message, "bad") });
  const remove = useMutation({ mutationFn: () => api<void>(`/tasks/${id}`, { method: "DELETE", revision: task.data?.revision }), onSuccess: () => { toast("任务已删除"); navigate("/board"); }, onError: error => toast((error as Error).message, "bad") });
  const [subtaskOpen, setSubtaskOpen] = useState(false);
  const [subtask, setSubtask] = useState({ title: "", body: "", role_id: "" });
  const createSubtask = useMutation({
    mutationFn: () => api<Task>("/tasks", { method: "POST", body: { title: subtask.title, body: subtask.body, role_id: Number(subtask.role_id), project_id: task.data?.project_id ?? null, perm: task.data?.perm || "full", run_mode: "batch", concurrent: false, dependency_mode: task.data?.project_id ? "weak" : "none", block_on_failure: false, parent_id: id, ...(task.data?.project_id ? { depends_on: id } : {}) } }),
    onSuccess: () => { setSubtaskOpen(false); setSubtask({ title: "", body: "", role_id: "" }); void queryClient.invalidateQueries({ queryKey: ["tasks", id, "children"] }); toast("子任务已创建并排队"); },
    onError: error => toast((error as Error).message, "bad")
  });
  const resume = useMutation({
    mutationFn: () => api<Task>(`/tasks/${id}/resume`, { method: "POST" }),
    onSuccess: () => { toast("已在原任务中重新排队"); void queryClient.invalidateQueries({ queryKey: keys.tasks }); void queryClient.invalidateQueries({ queryKey: keys.task(id) }); },
    onError: error => toast((error as Error).message, "bad")
  });
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const saveTemplate = useMutation({
    mutationFn: () => api("/templates", { method: "POST", body: { name: templateName || task.data?.title || `任务 #${id}`, body: task.data?.body || "", role_id: task.data?.role_id ?? null } }),
    onSuccess: () => { setTemplateOpen(false); setTemplateName(""); toast("已保存为模板"); void queryClient.invalidateQueries({ queryKey: ["templates"] }); },
    onError: error => toast((error as Error).message, "bad")
  });
  const discardWs = useMutation({
    mutationFn: () => api(`/workspace/${id}/discard`, { method: "POST" }),
    onSuccess: () => { toast("工作区已丢弃"); void queryClient.invalidateQueries({ queryKey: ["tasks", id, "workspace"] }); },
    onError: error => toast((error as Error).message, "bad")
  });
  const gitInit = useMutation({
    mutationFn: () => api(`/workspace/git-init`, { method: "POST", body: { path: task.data?.project_dir } }),
    onSuccess: () => { toast("Git 仓库已初始化"); void queryClient.invalidateQueries({ queryKey: ["tasks", id, "workspace"] }); void queryClient.invalidateQueries({ queryKey: keys.projects }); },
    onError: error => toast((error as Error).message, "bad")
  });
  const loadOlder = async () => {
    if (!allLogs.length || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await api<TaskLogPage>(`/tasks/${id}/logs?limit=200&before=${allLogs[0].id}`);
      setOlderLogs(prev => [...page.logs, ...prev]);
    } catch (error) {
      toast((error as Error).message, "bad");
    } finally {
      setLoadingOlder(false);
    }
  };
  const copyLogs = async () => {
    try {
      const data = await api<TaskLog[]>(`/tasks/${id}/logs?all=1`);
      await navigator.clipboard.writeText(data.map(log => log.content).join(""));
      toast(`已复制 ${data.length} 条日志`);
    } catch (error) {
      toast((error as Error).message, "bad");
    }
  };
  if (task.isLoading) return <Spinner />;
  if (!task.data) return <Empty title="任务不存在" copy="该任务可能已被删除。" />;
  const value = task.data;
  return <>
    <PageHeader kicker={`Task #${value.id}`} title={value.title} copy={`${value.project_name || "无项目"} · ${value.role_name || "未指派"}`} actions={<><TaskStatus status={value.status} /><Button variant="ghost" onClick={() => navigate(-1)}>返回</Button></>} />
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="grid gap-6">
        <Card><h2 className="mb-3 font-semibold">任务目标</h2><p className="whitespace-pre-wrap text-sm leading-7 text-muted">{value.body || "未填写任务说明"}</p></Card>
        {value.status === "awaiting_review" && <Card><h2 className="font-semibold">审批差异</h2><pre className="mt-3 max-h-[32rem] overflow-auto rounded-xl bg-[#080d15] p-4 text-xs leading-5 text-slate-200">{diff.data?.diff || diff.data?.note || "没有检测到差异"}</pre><div className="mt-4 flex gap-2"><Button variant="primary" onClick={() => mutate.mutate({ status: "succeeded" })}><Check size={16} />通过</Button><Button variant="danger" onClick={() => mutate.mutate({ status: "queued", review_note: "请根据审批意见修正后重新提交" })}><X size={16} />驳回重做</Button></div></Card>}
        {children.data?.length ? <Card><h2 className="font-semibold">子任务</h2><div className="mt-3 grid gap-2">{children.data.map(child => <TaskRow key={child.id} task={child} />)}</div></Card> : null}
        <Card><div className="mb-3 flex items-center gap-2"><h2 className="font-semibold">终端与日志</h2><Badge tone={value.run_mode === "interactive" ? "info" : "neutral"}>{value.run_mode}</Badge><div className="ml-auto flex gap-2"><Button size="sm" onClick={loadOlder} disabled={loadingOlder || (logs.data ? !logs.data.has_more && !olderLogs.length : true)}>加载更早</Button><Button size="sm" onClick={copyLogs}>复制全部</Button></div></div><TaskTerminal task={value} logs={allLogs} /></Card>
      </div>
      <aside className="grid content-start gap-4">
        <Card><h2 className="font-semibold">属性</h2><dl className="mt-4 grid gap-3 text-sm">{[["状态", statusLabel[value.status]], ["权限", value.perm], ["依赖", value.dependency_mode], ["审批轮次", value.review_rounds > 0 ? `${value.review_rounds} 轮` : null], ["创建", formatTime(value.created_at)], ["更新", formatTime(value.updated_at)]].filter(([, text]) => text != null).map(([key, text]) => <div key={key} className="flex gap-3"><dt className="w-14 text-muted">{key}</dt><dd className="min-w-0 flex-1 break-words">{text}</dd></div>)}</dl>
          {value.review_note ? <p className="mt-3 rounded-xl bg-elevated p-3 text-xs leading-5 text-muted"><b className="block text-ink">最近意见</b>{value.review_note}</p> : null}
          <div className="mt-4 grid gap-3 border-t border-line pt-4">
            <Field label="角色"><select className={inputClass} value={value.role_id || ""} onChange={e => mutate.mutate({ role_id: e.target.value ? Number(e.target.value) : null })}><option value="">未指派</option>{roles.data?.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select></Field>
            <Field label="项目" hint={value.depends_on != null ? "有前置依赖时不可改" : undefined}><select className={inputClass} value={value.project_id || ""} disabled={value.depends_on != null} onChange={e => mutate.mutate({ project_id: e.target.value ? Number(e.target.value) : null })}><option value="">不绑定</option>{projects.data?.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field>
            <Field label="依赖模式"><select className={inputClass} value={value.dependency_mode} onChange={e => mutate.mutate({ dependency_mode: e.target.value })}><option value="none">无依赖</option><option value="weak">弱依赖（失败跳过）</option><option value="strong">强依赖（失败阻塞）</option></select></Field>
            <label className="flex min-h-11 items-center gap-3 rounded-xl border border-line bg-elevated px-3 text-sm"><input type="checkbox" checked={value.block_on_failure} onChange={e => mutate.mutate({ block_on_failure: e.target.checked })} />失败后阻塞后续任务</label>
            <label className="flex min-h-11 items-center gap-3 rounded-xl border border-line bg-elevated px-3 text-sm"><input type="checkbox" checked={value.concurrent} onChange={e => mutate.mutate({ concurrent: e.target.checked })} />允许与同项目任务并行</label>
          </div>
        </Card>
        {workspace.data && (workspace.data.is_worktree || workspace.data.is_git) ? <Card><h2 className="font-semibold">工作区</h2><dl className="mt-4 grid gap-2 text-sm">{workspace.data.is_worktree ? <><div className="flex gap-3"><dt className="w-14 text-muted">分支</dt><dd className="min-w-0 flex-1 break-all font-mono text-xs">{workspace.data.branch}</dd></div><div className="flex gap-3"><dt className="w-14 text-muted">HEAD</dt><dd className="min-w-0 flex-1 break-all font-mono text-xs">{workspace.data.head || workspace.data.base_commit}</dd></div><div className="flex gap-3"><dt className="w-14 text-muted">状态</dt><dd className="min-w-0 flex-1">{workspace.data.dirty ? <Badge tone="warn">有未提交改动</Badge> : <Badge tone="good">干净</Badge>}</dd></div>{workspace.data.ahead > 0 && <div className="flex gap-3"><dt className="w-14 text-muted">领先</dt><dd className="min-w-0 flex-1">{workspace.data.ahead} 个提交</dd></div>}<div className="flex gap-3"><dt className="w-14 text-muted">合并</dt><dd className="min-w-0 flex-1">{workspace.data.merged ? <Badge tone="good">已合并</Badge> : <Badge>未合并</Badge>}</dd></div></> : <div className="flex gap-3"><dt className="w-14 text-muted">仓库</dt><dd className="min-w-0 flex-1">Git 项目</dd></div>}</dl>
          <div className="mt-4 grid gap-2">{(workspace.data.is_worktree && !workspace.data.merged) && <Button variant="danger" onClick={() => confirm("丢弃该任务的工作区改动？") && discardWs.mutate()}><RotateCcw size={15} />丢弃工作区</Button>}{(!workspace.data.is_git && value.project_dir) && <Button onClick={() => confirm(`在 ${value.project_dir} 初始化 Git 仓库？`) && gitInit.mutate()}><GitBranch size={15} />Git 初始化</Button>}</div>
        </Card> : null}
        {artifacts.data?.length ? <Card><h2 className="font-semibold">Artifacts</h2><div className="mt-3 grid gap-2">{artifacts.data.map(item => <a key={item.id} className="rounded-lg border border-line p-3 text-sm hover:border-brand/40" href={`/api/v1/artifacts/${item.id}/content`}><span className="block truncate font-medium">{item.name}</span><span className="mt-1 block text-xs text-muted">{item.media_type} · {formatBytes(item.size)}</span></a>)}</div></Card> : null}
        <Card><h2 className="font-semibold">操作</h2><div className="mt-4 grid gap-2">{["failed", "cancelled"].includes(value.status) && <Button onClick={() => mutate.mutate({ status: "queued" })}><RotateCcw size={16} />重试</Button>}{["queued", "claimed", "running"].includes(value.status) && <Button variant="danger" onClick={() => mutate.mutate({ status: "cancelled" })}><Square size={15} />取消</Button>}{value.run_mode === "interactive" && value.status === "running" && <Button onClick={() => api(`/tasks/${id}/end-session`, { method: "POST" })}><TerminalSquare size={16} />结束会话</Button>}{["succeeded", "failed", "cancelled"].includes(value.status) && <Button onClick={() => resume.mutate()}><Play size={16} />继续对话</Button>}<Button onClick={() => setSubtaskOpen(true)}><ListTree size={16} />拆分子任务</Button><Button onClick={() => { setTemplateName(value.title); setTemplateOpen(true); }}><Save size={16} />保存为模板</Button><Button variant="danger" onClick={() => { if (confirm("确定删除这个任务及其工作空间？")) remove.mutate(); }}>删除任务</Button></div></Card>
      </aside>
    </div>
    <Dialog open={subtaskOpen} onOpenChange={setSubtaskOpen} title="拆分子任务" description="子任务继承当前项目的弱依赖，等待父任务交付后执行。"><form className="grid gap-4" onSubmit={(event: FormEvent) => { event.preventDefault(); createSubtask.mutate(); }}>
      <Field label="标题"><input className={inputClass} required value={subtask.title} onChange={e => setSubtask({ ...subtask, title: e.target.value })} /></Field>
      <Field label="任务说明"><textarea className={inputClass + " min-h-28 py-3"} required value={subtask.body} onChange={e => setSubtask({ ...subtask, body: e.target.value })} /></Field>
      <Field label="角色"><select className={inputClass} required value={subtask.role_id} onChange={e => setSubtask({ ...subtask, role_id: e.target.value })}><option value="">选择角色</option>{roles.data?.filter(role => role.enabled).map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select></Field>
      <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setSubtaskOpen(false)}>取消</Button><Button type="submit" variant="primary" disabled={createSubtask.isPending}>创建子任务</Button></div>
    </form></Dialog>
    <Dialog open={templateOpen} onOpenChange={setTemplateOpen} title="保存为模板"><form className="grid gap-4" onSubmit={(event: FormEvent) => { event.preventDefault(); saveTemplate.mutate(); }}>
      <Field label="模板名称"><input className={inputClass} required value={templateName} onChange={e => setTemplateName(e.target.value)} /></Field>
      <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setTemplateOpen(false)}>取消</Button><Button type="submit" variant="primary" disabled={saveTemplate.isPending}>保存</Button></div>
    </form></Dialog>
  </>;
}

export function NewTaskDialog({ open, onOpenChange, initialProjectID }: { open: boolean; onOpenChange(open: boolean): void; initialProjectID?: number }) {
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const roles = useQuery({ queryKey: keys.roles, queryFn: () => api<Role[]>("/roles"), enabled: open });
  const projects = useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/projects"), enabled: open });
  const templates = useQuery({ queryKey: ["templates"], queryFn: () => api<TaskTemplate[]>("/templates"), enabled: open });
  const [form, setForm] = useState({ title: "", body: "", role_id: "", project_id: initialProjectID ? String(initialProjectID) : "", perm: "full", run_mode: "batch", concurrent: false });
  const create = useMutation({ mutationFn: () => api<Task>("/tasks", { method: "POST", body: { ...form, role_id: Number(form.role_id), project_id: Number(form.project_id), concurrent: form.concurrent, dependency_mode: "weak", block_on_failure: false } }), onSuccess: task => { void queryClient.invalidateQueries({ queryKey: keys.tasks }); onOpenChange(false); toast(`已创建任务 #${task.id}`); navigate(`/tasks/${task.id}`); }, onError: error => toast((error as Error).message, "bad") });
  const submit = (event: FormEvent) => { event.preventDefault(); create.mutate(); };
  return <Dialog open={open} onOpenChange={onOpenChange} title="新建任务" description="任务必须绑定 Role 与 Project；Runtime 只负责执行。"><form className="grid gap-4" onSubmit={submit}>
    <Field label="标题"><input className={inputClass} required value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} autoFocus /></Field>
    <Field label="从模板插入"><select className={inputClass} value="" onChange={event => { const item = templates.data?.find(value => value.id === Number(event.target.value)); if (item) setForm(current => ({ ...current, title: current.title || item.name, body: current.body ? `${current.body}\n\n${item.body}` : item.body })); }}><option value="">选择模板…</option>{templates.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
    <Field label="任务说明"><textarea className={inputClass + " min-h-32 py-3"} required value={form.body} onChange={event => setForm({ ...form, body: event.target.value })} /></Field>
    <div className="grid gap-4 sm:grid-cols-2"><Field label="项目"><select className={inputClass} required value={form.project_id} onChange={event => setForm({ ...form, project_id: event.target.value })}><option value="">选择项目</option>{projects.data?.filter(item => item.status === "active").map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label="角色"><select className={inputClass} required value={form.role_id} onChange={event => setForm({ ...form, role_id: event.target.value })}><option value="">选择角色</option>{roles.data?.filter(item => item.enabled).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field></div>
    <div className="grid gap-4 sm:grid-cols-2"><Field label="权限"><select className={inputClass} value={form.perm} onChange={event => setForm({ ...form, perm: event.target.value })}><option value="full">自动整合</option><option value="review">人工审批</option></select></Field><Field label="运行方式"><select className={inputClass} value={form.run_mode} onChange={event => setForm({ ...form, run_mode: event.target.value })}><option value="batch">批处理</option><option value="interactive">交互终端</option></select></Field></div>
    <label className="flex min-h-11 items-center gap-3 rounded-xl border border-line bg-elevated px-3 text-sm"><input type="checkbox" checked={form.concurrent} onChange={event => setForm({ ...form, concurrent: event.target.checked })} />允许与同项目其他任务并行</label>
    <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" variant="primary" disabled={create.isPending}><Play size={16} />创建并排队</Button></div>
  </form></Dialog>;
}

function formatTime(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatBytes(value: number) { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 / 1024).toFixed(1)} MiB`; }
