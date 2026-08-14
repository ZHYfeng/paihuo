import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Check, CirclePlus, Copy, GitBranch, ListFilter, ListTree, MessagesSquare, Play, RotateCcw, Save, TerminalSquare, Trash2, Workflow, X } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { PageHeader } from "../components/shell";
import { DiffView } from "../components/diff-view";
import { TaskTerminal } from "../components/terminal";
import { Badge, Button, Card, Dialog, Empty, Field, inputClass, Spinner, useToast } from "../components/ui";
import { useHotkeys } from "../lib/hotkeys";
import { api, keys } from "../lib/api";
import { BOARD_COLS, STATUS_LABEL, ST_COLOR, PERM_LABEL, canDeleteTask, canRetryTask, cleanLogContent, dependencyInfo, fmtDur, fmtPct, isMergeTask, mergeBlockReason, mergeTaskFor, retryTaskLabel, splitReviewRounds, terminalRenderableLog, tsOf } from "../lib/taskmeta";
import type { Artifact, OverviewStats, Project, ProvisionInfo, Role, Task, TaskLog, TaskLogPage, TaskTemplate, WorkspaceStatus } from "../types";

const statusTone: Record<string, "neutral" | "good" | "warn" | "bad" | "info"> = { queued: "neutral", claimed: "info", running: "info", awaiting_review: "warn", succeeded: "good", failed: "bad", cancelled: "neutral" };

export function TaskStatus({ status }: { status: string }) {
  return <Badge tone={statusTone[status] || "neutral"}>{STATUS_LABEL[status] || status}</Badge>;
}

function useTasks(query = "") {
  return useQuery({ queryKey: [...keys.tasks, query], queryFn: () => api<Task[]>(`/tasks${query}`), refetchInterval: 15_000 });
}

/* ---- 统计条（工作台 4 项 / 看板 6 项，旧 main.js renderStatsStrip） ---- */

function StatsStrip({ dashboard = false }: { dashboard?: boolean }) {
  const stats = useQuery({ queryKey: keys.stats, queryFn: () => api<OverviewStats>("/stats/overview") });
  const counts = stats.data?.status_counts || [];
  const review = counts.find(s => s.status === "awaiting_review");
  const daily = stats.data?.daily || [];
  const today = daily.length ? daily[daily.length - 1] : null;
  const chips: Array<[string, string | number, string]> = [
    ["进行中", stats.data?.in_flight || 0, "var(--st-running)"],
    ["待审批", review?.count || 0, "var(--st-review)"],
    ["今日完成", today?.count ?? 0, "var(--st-done)"],
    ["完成率", fmtPct(stats.data?.success_rate || 0), "var(--st-done)"],
    ["平均耗时", fmtDur(stats.data?.avg_duration || 0), "var(--fg-muted)"],
    ["活跃项目", stats.data?.projects || 0, "var(--fg-muted)"]
  ];
  const visible = dashboard ? [chips[1], chips[0], chips[2], chips[3]] : chips;
  return <div className="stat-strip">{visible.map(([label, value, color]) => <div key={label} className="stat-chip" style={{ "--metric-color": color } as React.CSSProperties} aria-label={`${label} ${value}`}>
    <span className="sc-dot" style={{ background: color }} /><b>{value}</b><span className="sc-label">{label}</span>
  </div>)}</div>;
}

/* ---- 卡片 chips（旧 task.js cardHTML） ---- */

function TaskKindChip({ task }: { task: Task }) {
  return isMergeTask(task)
    ? <span className="chip merge" title={`由源任务 #${task.merge_of} 自动创建`}>代码合并 · #{task.merge_of}</span>
    : <span className="chip task-kind">实现</span>;
}

function DependencyChip({ task, tasks }: { task: Task; tasks: Task[] }) {
  const info = dependencyInfo(task, tasks);
  if (info.mode === "system") return null;
  const kind = info.mode === "strong" ? "strong" : info.mode === "weak" ? "weak" : "none";
  return <span className={`chip dependency ${kind}`} title={info.reason || info.label}>{info.label}</span>;
}

function DependencyStateChip({ task, tasks }: { task: Task; tasks: Task[] }) {
  if (task.status !== "queued") return null;
  const info = dependencyInfo(task, tasks);
  if (info.state === "blocked") return <span className="chip dependency blocked" title={info.reason}>{info.stateLabel || "等待前序"}</span>;
  if (info.state === "skipped") return <span className="chip dependency skipped" title={info.reason}>{info.stateLabel || "前序已跳过"}</span>;
  return null;
}

function SourceMergeChip({ task, tasks }: { task: Task; tasks: Task[] }) {
  if (isMergeTask(task)) return null;
  const merge = mergeTaskFor(task, tasks);
  if (!merge) {
    return task.status === "succeeded" && task.worktree_branch
      ? <span className="chip merge-pending">正在创建合并</span> : null;
  }
  return <span className={`chip merge-state ${merge.status}`} title={`代码合并任务 #${merge.id}`}>合并：{STATUS_LABEL[merge.status] || merge.status}</span>;
}

function taskChips(task: Task, tasks: Task[], roles: Role[]): React.ReactNode {
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

function avatarInitial(name: string) { return (name || "?").slice(0, 1); }

/* ---- 工作台卡片（旧 dashboard.js dashCardHTML） ---- */

function DashCard({ task, actions, onOpen }: { task: Task; actions?: React.ReactNode; onOpen(): void }) {
  return <article className="card dash-card rounded-xl border border-line bg-elevated p-3.5 transition hover:border-brand/35" style={{ "--st-color": ST_COLOR[task.status] } as React.CSSProperties} onClick={onOpen}>
    <div className="c-top"><span className="st-dot" style={{ background: ST_COLOR[task.status] }} /><span className="c-id">#{task.id}</span>
      <span className="c-time">{formatTime(task.created_at)}</span>
      {task.perm === "review" ? <span className="chip review">审批</span> : null}</div>
    <Link to={`/tasks/${task.id}`} onClick={e => e.stopPropagation()} className="c-title mt-1 block truncate text-sm group-hover:text-brand-soft">{task.title}</Link>
    <div className="c-meta mt-1.5">
      {task.project_name ? <span className="chip">{task.project_name}</span> : null}
      <span className="ml-auto flex items-center gap-1 text-xs text-muted">
        {task.role_name ? <span className="flex items-center gap-1"><span className="grid size-5 place-items-center rounded-full bg-brand/10 text-[10px] font-semibold text-brand-soft">{avatarInitial(task.role_name)}</span>{task.role_name}</span> : <span className="text-faint">未指派</span>}
      </span>
    </div>
    {actions ? <div className="dash-actions mt-2.5 border-t border-line pt-2.5" onClick={e => e.stopPropagation()}>{actions}</div> : null}
  </article>;
}

/* ============================================================
   工作台
   ============================================================ */

export function DashboardPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const tasks = useTasks();
  const projects = useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/projects") });
  const roles = useQuery({ queryKey: keys.roles, queryFn: () => api<Role[]>("/roles") });
  const provisioning = useQuery({ queryKey: keys.provisioning, queryFn: () => api<ProvisionInfo[]>("/runtimes/provisioning") });
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const openTask = (id: number) => navigate(`/tasks/${id}`);
  const mutateStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) => api(`/tasks/${id}`, { method: "PATCH", body: { status } }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: keys.tasks }); queryClient.invalidateQueries({ queryKey: keys.stats }); toast("已更新"); },
    onError: error => toast((error as Error).message, "bad")
  });
  useHotkeys({ newTask: () => setCreateOpen(true) });
  const all = tasks.data || [];
  const running = all.filter(t => ["queued", "claimed", "running"].includes(t.status)).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 6);
  const review = all.filter(t => t.status === "awaiting_review").sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 6);
  const activeProjects = projects.data?.filter(p => p.status === "active") || [];
  const ranked = activeProjects.map(p => {
    const ts = all.filter(t => t.project_id === p.id);
    const done = ts.filter(t => t.status === "succeeded").length;
    const pct = ts.length ? Math.round(done / ts.length * 100) : 0;
    const inflight = ts.filter(t => ["queued", "claimed", "running", "awaiting_review"].includes(t.status)).length;
    return { p, pct, inflight };
  }).sort((a, b) => b.inflight - a.inflight || a.p.name.localeCompare(b.p.name, "zh-CN"));
  const visible = ranked.slice(0, 4);
  const installed = provisioning.data?.filter(p => p.installed) || [];
  return <>
    <PageHeader kicker="Operations overview" title="工作台" copy="一条路：创建任务（单任务 / 复合任务 / 自由探索 / 定时）→ 执行 → 审批；所有状态由持久事件流同步。" actions={<><Button variant="ghost" onClick={() => navigate("/sessions")}><MessagesSquare size={16} />自由探索</Button><Button variant="ghost" onClick={() => navigate("/workflows")}><Workflow size={16} />复合任务</Button><Button variant="ghost" onClick={() => navigate("/schedules")}><CalendarClock size={16} />定时</Button><Button variant="primary" onClick={() => setCreateOpen(true)}><CirclePlus size={17} />单任务</Button></>} />
    <StatsStrip dashboard />
    <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(18rem,.75fr)]">
      <div className="grid gap-6">
        <Card><div className="mb-4 flex items-center"><div><h2 className="font-semibold">待审批</h2><p className="mt-1 text-sm text-muted">需要人工确认的交付与采纳会集中出现在这里</p></div><Link to="/approvals" className="ml-auto text-sm text-brand-soft hover:underline">审批工作台 →</Link></div>
          {tasks.isLoading ? <Spinner /> : review.length ? <div className="grid gap-2">{review.map(task => <DashCard key={task.id} task={task} onOpen={() => openTask(task.id)} actions={<>
            <Button size="sm" variant="primary" disabled={mutateStatus.isPending} onClick={() => mutateStatus.mutate({ id: task.id, status: "succeeded" })}><Check size={14} />通过并合并</Button>
            <Button size="sm" onClick={() => openTask(task.id)}>驳回</Button>
            <Button size="sm" variant="ghost" onClick={() => openTask(task.id)}>查看详情</Button>
          </>} />)}</div> : <Empty title="当前无需审批" copy="需要人工确认的交付会集中出现在这里。" />}
        </Card>
        <Card><div className="mb-4 flex items-center"><div><h2 className="font-semibold">执行队列</h2><p className="mt-1 text-sm text-muted">创建任务后，进度会在这里实时更新</p></div><span className="ml-auto text-sm text-faint">{running.length} 个进行中</span></div>
          {tasks.isLoading ? <Spinner /> : running.length ? <div className="grid gap-2">{running.map(task => <DashCard key={task.id} task={task} onOpen={() => openTask(task.id)} />)}</div> : <Empty title="执行队列已清空" copy="创建任务后，进度会在这里实时更新。" action={<Button size="sm" onClick={() => setCreateOpen(true)}>派发任务</Button>} />}
        </Card>
      </div>
      <div className="grid content-start gap-6">
        <Card><h2 className="font-semibold">项目进展</h2>
          {projects.isLoading ? <Spinner /> : !activeProjects.length ? <div className="dash-onboard mt-3"><div className="ob-title">开始第一次交付</div>
            <Link className="ob-step" to="/roles"><b>01</b><span>创建任务角色</span></Link>
            <Link className="ob-step" to="/projects"><b>02</b><span>建立项目工作区</span></Link>
            <Link className="ob-step" to="/board"><b>03</b><span>派发首个任务</span></Link>
          </div> : <div className="mt-3 grid gap-2">{visible.map(({ p, pct, inflight }) => <Link key={p.id} className="dash-proj" to={`/projects/${p.id}`}>
            <div className="dp-top"><b title={p.name}>{p.name}</b>{inflight ? <span className="badge running inline-flex items-center gap-1 rounded-full border border-brand/30 bg-brand/10 px-2 py-0.5 text-[11px] text-brand-soft"><span className="st-dot" style={{ background: "var(--brand)" }} />{inflight} 活跃</span> : <span className="badge inline-flex items-center rounded-full border border-line bg-elevated px-2 py-0.5 text-[11px] text-muted">{all.filter(t => t.project_id === p.id).length} 任务</span>}</div>
            <div className="pc-progress"><div className="pp-bar"><div style={{ width: `${pct}%` }} /></div><span className="pc-pct">{pct}%</span></div>
          </Link>)}
            {ranked.length > visible.length ? <Link className="dash-more" to="/projects">查看其余 {ranked.length - visible.length} 个项目 →</Link> : null}</div>}
        </Card>
        <Card><div className="mb-3 flex items-center"><div><h2 className="font-semibold">运行环境</h2><p className="mt-1 text-sm text-muted">CLI 安装与登录状态</p></div></div>
          <div className="dash-prov">{provisioning.data?.map(p => <span key={p.id} className={`prov-chip ${p.installed ? "ok" : ""} ${p.login ? "login" : ""}`} title={`${p.name}${p.installed ? ` ${p.version}` : " — 未安装"}${p.installed && !p.login ? "（未登录）" : ""}`}><i aria-hidden="true" />{p.name}<span className="sr-only">{p.installed ? (p.login ? "已安装并登录" : "已安装，未登录") : "未安装"}</span></span>)}</div>
          <div className="dash-prov-meta"><span><b>{installed.length}/{provisioning.data?.length || 0}</b> 已安装</span><span><b>{roles.data?.filter(r => r.enabled).length || 0}</b> 角色启用</span></div>
        </Card>
      </div>
    </div>
    <NewTaskDialog open={createOpen} onOpenChange={setCreateOpen} />
  </>;
}

/* ============================================================
   看板
   ============================================================ */

function TaskCard({ task, tasks, roles }: { task: Task; tasks: Task[]; roles: Role[] }) {
  return <Link to={`/tasks/${task.id}`} className="card task-card block rounded-xl border border-line bg-elevated p-3 transition hover:border-brand/35 hover:bg-hover" style={{ "--st-color": ST_COLOR[task.status] } as React.CSSProperties}>
    <div className="flex items-center gap-1.5 text-[11px] text-faint"><span className="st-dot" style={{ background: ST_COLOR[task.status] }} /><span className="font-bold text-muted">#{task.id}</span><time className="text-faint">{formatTime(task.created_at)}</time></div>
    <div className="mt-1 text-[13px] font-semibold leading-5 text-ink">{task.title}</div>
    {task.body ? <div className="mt-1 line-clamp-2 text-xs leading-4 text-muted">{task.body}</div> : null}
    <div className="mt-2 flex flex-wrap items-center gap-1">{taskChips(task, tasks, roles)}</div>
    <div className="c-meta mt-2 flex items-center gap-1.5 text-xs text-muted">
      {task.project_id && task.project_name ? <Link to={`/projects/${task.project_id}`} className="chip chip-link hover:text-brand-soft" onClick={e => e.stopPropagation()} title="打开项目页">{task.project_name}</Link> : null}
      <span className="ml-auto flex items-center gap-1">{task.role_name ? <span className="flex items-center gap-1"><span className="grid size-5 place-items-center rounded-full bg-brand/10 text-[10px] font-semibold text-brand-soft">{avatarInitial(task.role_name)}</span><span className="c-agent-name">{task.role_name}</span></span> : <span className="text-faint">未指派</span>}
        {task.error ? <span className="text-danger">✗</span> : null}</span>
    </div>
  </Link>;
}

function BoardColumnsHTML({ tasks, roles, mergeSection }: { tasks: Task[]; roles: Role[]; mergeSection: boolean }) {
  const columns: Array<[string, string, string[]]> = mergeSection
    ? [...BOARD_COLS, ["merge-attention", "需处理", ["failed", "cancelled"]]]
    : BOARD_COLS;
  return <>{columns.map(([key, label, statuses]) => {
    const items = tasks.filter(t => statuses.includes(t.status));
    return <div key={key} className="board-col" style={{ "--st-color": ST_COLOR[statuses[0]] } as React.CSSProperties}>
      <div className="board-col-head"><span className="st-dot" /><span>{label}</span><span className="count">{items.length}</span></div>
      <div className="board-col-body">{items.map(task => <TaskCard key={task.id} task={task} tasks={tasks} roles={roles} />)}{!items.length ? <div className="empty">—</div> : null}</div>
    </div>;
  })}</>;
}

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
  const mutateStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) => api(`/tasks/${id}`, { method: "PATCH", body: { status } }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: keys.tasks }); queryClient.invalidateQueries({ queryKey: keys.stats }); toast("已更新"); },
    onError: error => toast((error as Error).message, "bad")
  });
  const removeTask = useMutation({
    mutationFn: (id: number) => api(`/tasks/${id}`, { method: "DELETE" }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: keys.tasks }); queryClient.invalidateQueries({ queryKey: keys.stats }); toast("已删除"); },
    onError: error => toast((error as Error).message, "bad")
  });
  useHotkeys({ newTask: () => setCreateOpen(true) });
  return <>
    <PageHeader kicker="Delivery pipeline" title="任务" copy="任务状态机、依赖交付、审批和代码整合保持确定性。" actions={<Button variant="primary" onClick={() => setCreateOpen(true)}><CirclePlus size={17} />新建任务</Button>} />
    <StatsStrip />
    <Card className="mb-5 mt-4 flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
      <span className="flex items-center gap-2 px-2 text-sm text-muted"><ListFilter size={16} />筛选</span>
      <select className={inputClass + " sm:w-40"} value={roleID} onChange={event => setRoleID(event.target.value)} aria-label="按角色筛选"><option value="">全部角色</option>{roles.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <select className={inputClass + " sm:w-44"} value={project} onChange={event => setProject(event.target.value)} aria-label="按项目筛选"><option value="">全部项目</option>{projects.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <select className={inputClass + " sm:w-36"} value={status} onChange={event => setStatus(event.target.value)} aria-label="按状态筛选"><option value="">全部状态</option>{Object.entries(STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <span className="text-sm text-muted sm:ml-auto">{sourceTasks.length} 个实现 · {mergeTasks.length} 个合并</span>
      <div className="flex rounded-xl border border-line bg-elevated p-0.5" role="tablist" aria-label="视图切换">
        <button role="tab" aria-selected={view === "board"} className={`rounded-[10px] px-3 py-1.5 text-sm ${view === "board" ? "bg-surface font-semibold text-ink shadow-sm" : "text-muted"}`} onClick={() => setView("board")}>看板</button>
        <button role="tab" aria-selected={view === "list"} className={`rounded-[10px] px-3 py-1.5 text-sm ${view === "list" ? "bg-surface font-semibold text-ink shadow-sm" : "text-muted"}`} onClick={() => setView("list")}>列表</button>
      </div>
    </Card>
    {tasks.isLoading ? <Spinner /> : view === "board" ? <div className="grid gap-6">
      <section className="board-section"><div className="board-section-head"><div><h2>实现任务</h2><p>项目任务默认按创建时间顺序交付，也可在项目页调整；每项完成后会先处理自己的代码合并。</p></div><div className="board-section-counts"><span>{sourceTasks.length} 个</span></div></div>
        <div className="board-section-lanes">{sourceTasks.length ? <BoardColumnsHTML tasks={sourceTasks} roles={roles.data || []} mergeSection={false} /> : <div className="board-section-empty">没有符合条件的实现任务。</div>}</div></section>
      <section className="board-section merge-section"><div className="board-section-head"><div><h2>代码合并</h2><p>使用新的独立 worktree 验证、解决冲突并自动写入主分支。</p></div><div className="board-section-counts"><span>{mergeTasks.length} 个</span>{mergeTasks.filter(t => mergeBlockReason(t, roles.data || [])).length ? <span className="chip merge-blocked">{mergeTasks.filter(t => mergeBlockReason(t, roles.data || [])).length} 个角色不可用</span> : null}</div></div>
        <div className="board-section-lanes">{mergeTasks.length ? <BoardColumnsHTML tasks={mergeTasks} roles={roles.data || []} mergeSection={true} /> : <div className="board-section-empty">还没有代码合并任务；实现任务完成后会自动出现在这里。</div>}</div></section>
    </div> : <Card className="overflow-hidden p-0"><table className="w-full text-sm"><thead><tr className="border-b border-line text-left text-xs text-faint">
      <th className="px-4 py-2.5 font-medium">ID</th><th className="px-4 py-2.5 font-medium">标题</th><th className="px-4 py-2.5 font-medium">类型</th><th className="px-4 py-2.5 font-medium">角色</th><th className="px-4 py-2.5 font-medium">项目</th><th className="px-4 py-2.5 font-medium">状态</th><th className="px-4 py-2.5 font-medium">轮次</th><th className="px-4 py-2.5 font-medium">创建</th><th className="px-4 py-2.5 font-medium">结束</th><th className="px-4 py-2.5 font-medium">操作</th>
    </tr></thead><tbody className="divide-y divide-line">{filtered.map(task => <tr key={task.id} className="list-row hover:bg-hover" onClick={() => navigate(`/tasks/${task.id}`)}>
      <td className="px-4 py-2.5 text-faint">#{task.id}</td>
      <td className="t-title px-4 py-2.5"><Link to={`/tasks/${task.id}`} onClick={e => e.stopPropagation()} className="hover:text-brand-soft">{task.title}</Link>{isMergeTask(task) ? <span className="chip merge ml-1">合并 #{task.merge_of}</span> : null}</td>
      <td className="px-4 py-2.5"><span className="task-list-chips">{taskChips(task, all, roles.data || [])}</span></td>
      <td className="px-4 py-2.5 text-muted">{task.role_name || "-"}</td>
      <td className="px-4 py-2.5 text-muted">{task.project_name || "-"}</td>
      <td className="px-4 py-2.5"><TaskStatus status={task.status} /></td>
      <td className="px-4 py-2.5 text-faint">{task.review_rounds || "—"}</td>
      <td className="px-4 py-2.5 text-faint">{formatTime(task.created_at)}</td>
      <td className="px-4 py-2.5 text-faint">{formatTime(task.finished_at)}</td>
      <td className="px-4 py-2.5"><span className="ops inline-flex gap-1.5">
        {canRetryTask(task, all) ? <Button size="sm" variant="ghost" title={retryTaskLabel(task)} onClick={e => { e.stopPropagation(); mutateStatus.mutate({ id: task.id, status: "queued" }); }}><RotateCcw size={13} /><span className="hidden sm:inline">{retryTaskLabel(task)}</span></Button> : null}
        {canDeleteTask(task) ? <Button size="sm" variant="danger" title="删除任务" onClick={e => { e.stopPropagation(); if (confirm(`删除任务 #${task.id}？执行日志、worktree、任务分支及其合并子任务将一并删除。`)) removeTask.mutate(task.id); }}><Trash2 size={13} /><span className="hidden sm:inline">删除</span></Button> : null}
      </span></td>
    </tr>)}</tbody></table>{!filtered.length ? <div className="p-8"><Empty title="没有符合条件的任务" copy="调整筛选条件试试。" /></div> : null}</Card>}
    <NewTaskDialog open={createOpen} onOpenChange={setCreateOpen} />
  </>;
}

/* ============================================================
   历史
   ============================================================ */

export function HistoryPage() {
  const tasks = useTasks("?limit=500");
  const roles = useQuery({ queryKey: keys.roles, queryFn: () => api<Role[]>("/roles") });
  const qc = useQueryClient();
  const toast = useToast();
  const [roleID, setRoleID] = useState("");
  const [status, setStatus] = useState("");
  const [days, setDays] = useState("");
  const [cutoff, setCutoff] = useState(0);
  const onDaysChange = (value: string) => {
    setDays(value);
    setCutoff(value ? Date.now() - Number(value) * 86400_000 : 0);
  };
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const all = useMemo(() => tasks.data || [], [tasks.data]);
  const terminal = useMemo(() => all.filter(task => ["succeeded", "failed", "cancelled"].includes(task.status)), [all]);
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
  const refresh = () => { qc.invalidateQueries({ queryKey: ["tasks"] }); qc.invalidateQueries({ queryKey: keys.tasks }); qc.invalidateQueries({ queryKey: keys.stats }); };
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
  const retry = useMutation({
    mutationFn: (id: number) => api(`/tasks/${id}`, { method: "PATCH", body: { status: "queued" } }),
    onSuccess: () => { refresh(); toast("已重新排队"); },
    onError: error => toast((error as Error).message, "bad")
  });
  const remove = useMutation({
    mutationFn: (id: number) => api(`/tasks/${id}`, { method: "DELETE" }),
    onSuccess: () => { refresh(); toast("已删除"); },
    onError: error => toast((error as Error).message, "bad")
  });
  return <>
    <PageHeader kicker="Audit history" title="历史" copy="已结算任务及其退出原因、审批轮次和时间。" />
    <Card className="mb-5 flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
      <span className="flex items-center gap-2 px-2 text-sm text-muted"><ListFilter size={16} />筛选</span>
      <select className={inputClass + " sm:w-40"} value={roleID} onChange={event => setRoleID(event.target.value)} aria-label="按角色筛选"><option value="">全部角色</option>{roles.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <select className={inputClass + " sm:w-36"} value={status} onChange={event => setStatus(event.target.value)} aria-label="按状态筛选"><option value="">全部状态</option>{Object.entries(STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <Field label="天数"><input type="number" min={1} className={inputClass + " sm:w-28"} value={days} onChange={event => onDaysChange(event.target.value)} placeholder="全部时间" aria-label="按天数筛选" /></Field>
      <span className="text-sm text-muted sm:ml-auto">{filtered.length} 条</span>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={toggleAll}>全选非合并</Button>
        <Button size="sm" variant="danger" disabled={!selected.size || removeSelected.isPending} onClick={() => confirm(`删除选中的 ${selected.size} 条历史任务？`) && removeSelected.mutate()}>删除选中{selected.size ? `（${selected.size}）` : ""}</Button>
        <Button size="sm" disabled={!days || cleanup.isPending} title={days ? "按当前角色与时间筛选清理" : "请先填写天数"} onClick={() => confirm(`清理当前筛选下的历史任务（${days ? `近 ${days} 天` : ""}）？不可恢复！`) && cleanup.mutate()}>清理筛选结果</Button>
      </div>
    </Card>
    {tasks.isLoading ? <Spinner /> : filtered.length ? <Card className="overflow-hidden p-0"><table className="w-full text-sm"><thead><tr className="border-b border-line text-left text-xs text-faint">
      <th className="px-4 py-2.5 font-medium"><input type="checkbox" aria-label="全选非合并任务" checked={filtered.filter(t => !t.merge_of).every(t => selected.has(t.id)) && filtered.some(t => !t.merge_of)} onChange={toggleAll} className="size-4 accent-[var(--brand)]" /></th>
      <th className="px-4 py-2.5 font-medium">ID</th><th className="px-4 py-2.5 font-medium">标题</th><th className="px-4 py-2.5 font-medium">角色</th><th className="px-4 py-2.5 font-medium">项目</th><th className="px-4 py-2.5 font-medium">权限</th><th className="px-4 py-2.5 font-medium">状态</th><th className="px-4 py-2.5 font-medium">轮次</th><th className="px-4 py-2.5 font-medium">创建</th><th className="px-4 py-2.5 font-medium">结束</th><th className="px-4 py-2.5 font-medium">操作</th>
    </tr></thead><tbody className="divide-y divide-line">{filtered.map(task => <tr key={task.id} className="history-row hover:bg-hover">
      <td className="px-4 py-2.5"><input type="checkbox" aria-label={`选择任务 ${task.title}`} checked={selected.has(task.id)} onChange={() => toggle(task.id)} className="size-4 accent-[var(--brand)]" /></td>
      <td className="px-4 py-2.5 text-faint">#{task.id}</td>
      <td className="px-4 py-2.5 font-medium"><Link to={`/tasks/${task.id}`} className="hover:text-brand-soft">{task.title}</Link>{task.merge_of ? <span className="chip merge ml-1">合并 #{task.merge_of}</span> : null}</td>
      <td className="px-4 py-2.5 text-muted">{task.role_name || "-"}</td>
      <td className="px-4 py-2.5 text-muted">{task.project_name || "-"}</td>
      <td className="px-4 py-2.5 text-muted">{PERM_LABEL[task.perm] || task.perm}</td>
      <td className="px-4 py-2.5"><TaskStatus status={task.status} /></td>
      <td className="px-4 py-2.5 text-faint">{task.review_rounds || ""}</td>
      <td className="px-4 py-2.5 text-faint">{formatTime(task.created_at)}</td>
      <td className="px-4 py-2.5 text-faint">{formatTime(task.finished_at)}</td>
      <td className="px-4 py-2.5"><span className="ops inline-flex gap-1.5">
        {canRetryTask(task, all) ? <Button size="sm" variant="ghost" title={retryTaskLabel(task)} onClick={() => retry.mutate(task.id)}><RotateCcw size={13} /><span className="hidden sm:inline">{retryTaskLabel(task)}</span></Button> : null}
        {canDeleteTask(task) ? <Button size="sm" variant="danger" title="删除任务" onClick={() => confirm(`删除任务 #${task.id}？执行日志、worktree、任务分支及其合并子任务将一并删除。`) && remove.mutate(task.id)}><Trash2 size={13} /><span className="hidden sm:inline">删除</span></Button> : null}
      </span></td>
    </tr>)}</tbody></table></Card> : <Empty title="没有符合条件的记录" copy="调整筛选条件，或等任务进入终态。" />}
  </>;
}

/* ============================================================
   任务详情
   ============================================================ */

function TaskBody({ task }: { task: Task }) {
  const { intro, rounds } = splitReviewRounds(task.body);
  return <div className="task-prompt-body">{intro || "未填写任务说明"}
    {rounds.map(round => <div key={round.round} className="review-round"><div className="review-round-head">修改意见 · 第 {round.round} 轮{round.time ? <time>{round.time}</time> : null}</div>{round.note || ""}</div>)}
  </div>;
}

function ChildrenSections({ task, onOpen }: { task: Task; onOpen(id: number): void }) {
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

function WorkspaceCard({ task }: { task: Task }) {
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

function LogFilterToggle({ mode, onToggle }: { mode: "all" | "err"; onToggle(): void }) {
  return <Button size="sm" variant="ghost" className={mode === "err" ? "active-filter" : ""} onClick={onToggle}>{mode === "err" ? "✓ " : ""}只看错误</Button>;
}

export function TaskDetailPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [logFilter, setLogFilter] = useState<"all" | "err">("all");
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectNote, setRejectNote] = useState("");
  const task = useQuery({ queryKey: keys.task(id), queryFn: () => api<Task>(`/tasks/${id}`), refetchInterval: 5000 });
  const tasks = useTasks();
  const roles = useQuery({ queryKey: keys.roles, queryFn: () => api<Role[]>("/roles") });
  const projects = useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/projects") });
  const logs = useQuery({ queryKey: ["tasks", id, "logs"], queryFn: () => api<TaskLogPage>(`/tasks/${id}/logs?limit=500`), refetchInterval: task.data?.status === "running" ? 1500 : false });
  const [olderLogs, setOlderLogs] = useState<TaskLog[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const allLogs = [...olderLogs, ...(logs.data?.logs || [])];
  const diff = useQuery({ queryKey: ["tasks", id, "diff"], queryFn: () => api<{ stat: string; diff: string; note?: string }>(`/tasks/${id}/diff`) });
  const artifacts = useQuery({ queryKey: ["tasks", id, "artifacts"], queryFn: () => api<Artifact[]>(`/artifacts?task_id=${id}`) });
  const mutate = useMutation({ mutationFn: (body: Record<string, unknown>) => api<Task>(`/tasks/${id}`, { method: "PATCH", revision: task.data?.revision, body }), onSuccess: value => { queryClient.setQueryData(keys.task(id), value); void queryClient.invalidateQueries({ queryKey: keys.tasks }); queryClient.invalidateQueries({ queryKey: keys.stats }); toast("任务已更新"); }, onError: error => toast((error as Error).message, "bad") });
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
  const endSession = useMutation({
    mutationFn: () => api<{ sent: string }>(`/tasks/${id}/end-session`, { method: "POST" }),
    onSuccess: data => { toast(`已发送 ${data.sent}，等待 agent 退出`); },
    onError: error => toast((error as Error).message, "bad")
  });
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const saveTemplate = useMutation({
    mutationFn: () => api("/templates", { method: "POST", body: { name: templateName || task.data?.title || `任务 #${id}`, body: task.data?.body || "", role_id: task.data?.role_id ?? null } }),
    onSuccess: () => { setTemplateOpen(false); setTemplateName(""); toast("已保存为模板"); void queryClient.invalidateQueries({ queryKey: ["templates"] }); },
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
  const all = tasks.data || [];
  const mergeTask = isMergeTask(value);
  const dependency = dependencyInfo(value, all);
  const mergeSource = mergeTask ? all.find(t => t.id === value.merge_of) : null;
  const mergeBlocked = mergeTask ? mergeBlockReason(value, roles.data || []) : "";
  const interactive = value.run_mode === "interactive";
  const isLive = interactive && ["claimed", "running"].includes(value.status);
  const runMode = interactive ? "交互式" : "批处理";
  const createdAt = String(value.created_at || "").slice(0, 16).replace("T", " ");
  const renderableLogs = allLogs.filter(terminalRenderableLog);
  const visibleLogs = renderableLogs.filter(l => cleanLogContent(l.content).trim()).length;
  const logErrors = allLogs.filter(l => l.stream === "err").length;
  const logMeta = interactive
    ? isLive ? "实时画面 · 跟随浏览器尺寸" : `已归档画面 · ${value.terminal_cols || 80} × ${value.terminal_rows || 24}`
    : logs.data?.has_more || olderLogs.length ? `已加载 ${visibleLogs}/${logs.data?.total ?? visibleLogs} 条` : `${visibleLogs} 条`;
  const dependencyAlert = !mergeTask && value.status === "queued" && dependency.state !== "ready"
    ? <div className="task-alert"><span className="task-alert-title">{dependency.state === "skipped" ? "前序交付已跳过" : "等待前置交付"}</span><span>{dependency.reason || "等待调度"}</span></div> : null;
  const errorAlert = value.error ? <div className="task-alert"><span className="task-alert-title">{mergeTask ? "代码合并失败" : "任务失败"}</span><span>{value.error}</span></div> : null;
  const statusOpts = Object.keys(STATUS_LABEL).map(s => <option key={s} value={s} selected={s === value.status}>{STATUS_LABEL[s]}</option>);
  const agentOpts = <><option value="">不指派</option>{roles.data?.filter(a => a.enabled || a.id === value.role_id).map(a => <option key={a.id} value={a.id} selected={a.id === value.role_id}>{a.name}</option>)}</>;
  const pOpts = <><option value="">无项目</option>{projects.data?.map(p => <option key={p.id} value={p.id} selected={p.id === value.project_id}>{p.name}</option>)}</>;
  const canMoveProject = value.dependency_mode === "none" && !value.depends_on;
  const filteredLogs = logFilter === "err" ? allLogs.filter(l => l.stream === "err") : allLogs;
  return <>
    <PageHeader kicker={`Task #${value.id}`} title={value.title} copy={`${value.project_name || "无项目"} · ${value.role_name || "未指派"}`} actions={<><TaskStatus status={value.status} /><Button variant="ghost" onClick={() => navigate(-1)}>返回</Button></>} />
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0">
        <section className="task-hero">
          <div className="task-kicker"><span>{mergeTask ? `代码合并任务 · 来源 #${value.merge_of}` : `实现任务 #${value.id}`}</span><span>创建于 {createdAt}</span></div>
          <h2>{value.title}</h2>
          <div className="task-meta">
            <span className="task-meta-item"><span className="grid size-5 place-items-center rounded-full bg-brand/10 text-[10px] font-semibold text-brand-soft">{avatarInitial(value.role_name || "?")}</span>{value.role_name || "未指派"}</span>
            {value.project_name ? <span className="task-meta-item">{value.project_name}</span> : null}
            <span className="task-meta-item">{runMode}</span>
            {!mergeTask ? <DependencyChip task={value} tasks={all} /> : null}
            {!mergeTask ? <DependencyStateChip task={value} tasks={all} /> : null}
            {mergeTask ? <span className="task-meta-item task-meta-accent">{mergeSource ? `源任务：#${mergeSource.id}` : `源任务：#${value.merge_of}`}</span> : <SourceMergeChip task={value} tasks={all} />}
            {value.resume_of ? <span className="task-meta-item task-meta-accent">续跑自 #{value.resume_of}</span> : null}
          </div>
        </section>
        {value.body ? <details className="task-section task-prompt" open={value.body.length <= 160}>
          <summary><span>任务说明</span><span className="section-meta">{value.body.length} 字</span></summary>
          <TaskBody task={value} />
        </details> : null}
        {dependencyAlert}
        {errorAlert}
        <ChildrenSections task={value} onOpen={id => navigate(`/tasks/${id}`)} />
        <details className="task-section task-diff" open={value.status === "awaiting_review" || value.status === "running"}>
          <summary><span>代码改动</span><span className="section-meta">{value.status === "awaiting_review" ? "等待审批" : "git diff"}</span></summary>
          <div className="pt-2">{diff.isLoading ? <Spinner /> : <DiffView taskId={id} status={value.status} stat={diff.data?.stat} diff={diff.data?.diff || ""} note={diff.data?.note} />}</div>
        </details>
        <details className="task-section task-log-section" open={isLive || !interactive}>
          <summary><span>{interactive ? "交互终端" : "执行记录"}</span><span className="section-meta">{logMeta}{logErrors && !interactive ? ` · ${logErrors} 个错误` : ""}</span></summary>
          <div className="section-head">
            <div className="section-sub">{value.role_name || "未指派"} · {runMode}</div>
            <div className="section-tools">
              {interactive ? null : <LogFilterToggle mode={logFilter} onToggle={() => setLogFilter(logFilter === "err" ? "all" : "err")} />}
              <Button size="sm" variant="ghost" onClick={() => void copyLogs()}><Copy size={14} />{interactive ? "复制画面" : "复制"}</Button>
            </div>
          </div>
          {interactive
            ? <TaskTerminal task={value} logs={renderableLogs} onLoadOlder={loadOlder} hasMore={logs.data?.has_more || false} />
            : <div className="log-lines mt-2" onScroll={e => { if (e.currentTarget.scrollTop <= 64) loadOlder(); }}>
              {filteredLogs.map((log, index) => {
                const content = cleanLogContent(log.content);
                if (!content.trim() && log.stream !== "sys") return null;
                return <div key={log.id}>
                  {logFilter === "err" && index > 0 && filteredLogs[index - 1].stream !== "err" ? <div className="err-divider" /> : null}
                  <div className="line"><span className="ts">{tsOf(log)}</span><span className={`c ${log.stream}`}>{content}</span></div>
                </div>;
              })}
              {!renderableLogs.length ? <div className="line"><span className="ts" /><span className="c out">（暂无输出）</span></div> : null}
            </div>}
        </details>
        <WorkspaceCard task={value} />
      </div>
      <aside className="grid content-start gap-4">
        {mergeTask
          ? <details className="side-collapse side-properties" open>
            <summary><span>合并任务属性</span><span className="section-meta">系统管理</span></summary>
            <div className="side-collapse-body">
              <div className="prop-row"><span className="k">来源</span><span className="v"><Button size="sm" variant="ghost" onClick={() => navigate(`/tasks/${value.merge_of}`)}>任务 #{value.merge_of}</Button></span></div>
              <div className="prop-row"><span className="k">状态</span><span className="v">{STATUS_LABEL[value.status] || value.status}</span></div>
              <div className="prop-row"><span className="k">角色</span><span className="v">{value.role_name || "未指派"}{mergeBlocked ? ` · ${mergeBlocked}` : ""}</span></div>
              <div className="prop-row"><span className="k">策略</span><span className="v">独立 worktree · 串行 · 自动写入主分支{mergeSource?.block_on_failure ? " · 失败阻塞后续自动任务" : " · 失败可跳过"}</span></div>
            </div>
          </details>
          : <details className="side-collapse side-properties" open>
            <summary><span>任务属性</span><span className="section-meta">可编辑</span></summary>
            <div className="side-collapse-body">
              <div className="prop-row"><span className="k">状态</span><span className="v"><select className={inputClass} onChange={e => mutate.mutate({ status: e.target.value })}>{statusOpts}</select></span></div>
              <div className="prop-row"><span className="k">项目</span><span className="v"><select className={inputClass} disabled={!canMoveProject} title={canMoveProject ? undefined : "有前置依赖的任务不能改项目"} onChange={e => mutate.mutate({ project_id: e.target.value ? Number(e.target.value) : null })}>{pOpts}</select></span></div>
              <div className="prop-row"><span className="k">角色</span><span className="v"><select className={inputClass} aria-label="任务角色" onChange={e => mutate.mutate({ role_id: e.target.value ? Number(e.target.value) : null })}>{agentOpts}</select></span></div>
              <div className="prop-row"><span className="k">权限</span><span className="v">{value.perm === "full" ? "自动合并" : "审批后合并"}</span></div>
              <div className="prop-row"><span className="k">方式</span><span className="v">{runMode}</span></div>
              <div className="prop-row"><span className="k">前置交付</span><span className="v"><DependencyChip task={value} tasks={all} />{dependency.state !== "ready" ? <span title={dependency.reason || ""}>{dependency.stateLabel || dependency.reason || "等待"}</span> : null}</span></div>
              <div className="prop-row"><span className="k">失败后</span><span className="v"><select className={inputClass} onChange={e => mutate.mutate({ block_on_failure: e.target.value === "1" })}><option value="0" selected={!value.block_on_failure}>后续弱依赖可跳过</option><option value="1" selected={value.block_on_failure}>阻塞后续弱依赖</option></select></span></div>
              <div className="prop-row"><span className="k">并发</span><span className="v"><select className={inputClass} onChange={e => mutate.mutate({ concurrent: e.target.value === "1" })}><option value="0" selected={!value.concurrent}>不重叠执行（默认）</option><option value="1" selected={value.concurrent}>允许资源并发</option></select></span></div>
            </div>
          </details>}
        <details className="side-collapse"><summary><span>运行信息</span><span className="section-meta">技术细节</span></summary>
          <div className="side-collapse-body">
            <div className="prop-row"><span className="k">执行器</span><span className="v">tmux · {["claimed", "running"].includes(value.status) ? `paihuo:task-${value.id}` : "日志已归档"}</span></div>
            <div className="prop-row"><span className="k">目录</span><span className="v prop-mono" title={value.project_dir || ""}>{value.project_dir || "-"}</span></div>
            <div className="prop-row"><span className="k">审批轮次</span><span className="v">{value.review_rounds || "-"}</span></div>
            <div className="prop-row"><span className="k">开始</span><span className="v">{String(value.started_at || "-").slice(0, 16).replace("T", " ")}</span></div>
            <div className="prop-row"><span className="k">结束</span><span className="v">{String(value.finished_at || "-").slice(0, 16).replace("T", " ")}</span></div>
          </div>
        </details>
        {artifacts.data?.length ? <Card><h2 className="font-semibold">Artifacts</h2><div className="mt-3 grid gap-2">{artifacts.data.map(item => <a key={item.id} className="rounded-lg border border-line p-3 text-sm hover:border-brand/40" href={`/api/v1/artifacts/${item.id}/content`}><span className="block truncate font-medium">{item.name}</span><span className="mt-1 block text-xs text-muted">{item.media_type} · {formatBytes(item.size)}</span></a>)}</div></Card> : null}
        <section className="side-actions">
          <div className="side-heading">下一步</div>
          <div className="detail-actions">
            {["queued", "claimed", "running"].includes(value.status) ? <Button variant="danger" onClick={() => { if (confirm("取消该任务？")) mutate.mutate({ status: "cancelled" }); }}><X size={15} />取消任务</Button> : null}
            {interactive && value.status === "running" ? <Button onClick={() => { if (confirm("结束交互会话？将向终端发送该 CLI 的退出命令（pi 为 /quit），agent 收尾后任务按正常退出结果结算。")) endSession.mutate(); }}><TerminalSquare size={15} />结束会话</Button> : null}
            {value.status === "awaiting_review" ? <>
              <Button variant="primary" onClick={() => { mutate.mutate({ status: "succeeded" }); toast("已审批，代码合并任务已派发"); }}><Check size={15} />通过并派发合并</Button>
              <Button onClick={() => { setRejectNote(""); setRejectOpen(true); }}><RotateCcw size={15} />驳回重做</Button>
              <Button variant="danger" onClick={() => { if (confirm("取消该任务？")) mutate.mutate({ status: "cancelled" }); }}><X size={15} />取消</Button>
            </> : null}
            {canRetryTask(value, all) ? <Button onClick={() => mutate.mutate({ status: "queued" })}><RotateCcw size={15} />{retryTaskLabel(value)}</Button> : null}
            {canRetryTask(value, all) && !mergeTask ? <Button onClick={() => { if (confirm(`继续任务 #${value.id}？将保留任务编号、任务会话目录、工作空间和历史记录，重新排队执行。`)) resume.mutate(); }}><TerminalSquare size={15} />继续对话</Button> : null}
            {!["queued", "claimed", "running", "awaiting_review"].includes(value.status) && <span className="side-muted">暂无需要处理的操作</span>}
          </div>
          <details className="side-more-actions">
            <summary>更多操作</summary>
            <div className="detail-actions">
              {mergeTask
                ? <Button variant="ghost" onClick={() => navigate(`/tasks/${value.merge_of}`)}>打开源任务 #{value.merge_of}</Button>
                : <>
                  <Button variant="ghost" onClick={() => setSubtaskOpen(true)}><ListTree size={15} />拆分子任务</Button>
                  {value.body ? <Button variant="ghost" onClick={() => { setTemplateName(value.title); setTemplateOpen(true); }}><Save size={15} />保存为模板</Button> : null}
                  <Button variant="ghost" onClick={() => { if (confirm("确定删除这个任务及其工作空间？")) remove.mutate(); }}><Trash2 size={15} />删除任务</Button>
                </>}
            </div>
          </details>
        </section>
      </aside>
    </div>
    <Dialog open={rejectOpen} onOpenChange={setRejectOpen} title="驳回重做" description="填写驳回原因 / 修改意见（将追加到任务提示词，重新执行）。">
      <form className="grid gap-4" onSubmit={(event: FormEvent) => { event.preventDefault(); mutate.mutate({ status: "queued", review_note: rejectNote }); setRejectOpen(false); toast("已驳回，任务重新执行"); }}>
        <Field label="驳回原因"><textarea className={inputClass + " min-h-28 py-3"} autoFocus required value={rejectNote} onChange={e => setRejectNote(e.target.value)} placeholder="例如：接口命名不符合规范，请改为…" /></Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setRejectOpen(false)}>取消</Button><Button type="submit" variant="primary">驳回并重新执行</Button></div>
      </form>
    </Dialog>
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
