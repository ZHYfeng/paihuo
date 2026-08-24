import { useQuery } from "@tanstack/react-query";
import { Check, CirclePlus } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PageHeader } from "../../components/shell";
import { DashCard } from "../../components/task/task-card";
import { NewTaskDialog } from "../../components/task/create-dialog";
import { StatsStrip } from "../../components/task/stats-strip";
import { Button, Card, Empty, Spinner } from "../../components/ui";
import { useHotkeys } from "../../lib/hotkeys";
import { api, keys } from "../../lib/api";
import type { Project, ProvisionInfo, Role } from "../../types";
import { useTasks, useTaskStatusMutation } from "../../hooks/useTasks";

export function DashboardPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const tasks = useTasks();
  const projects = useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/projects") });
  const roles = useQuery({ queryKey: keys.roles, queryFn: () => api<Role[]>("/roles") });
  const provisioning = useQuery({ queryKey: keys.provisioning, queryFn: () => api<ProvisionInfo[]>("/runtimes/provisioning") });
  const navigate = useNavigate();
  const openTask = (id: number) => navigate(`/tasks/${id}`);
  const mutateStatus = useTaskStatusMutation();
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
    <PageHeader title="工作台" copy="一条路：项目 → 创建任务（任务 / 会话 / 工作流 / 定时）→ 执行 → 审批；定时是正交属性，任何形态都可挂 cron。所有状态由持久事件流同步。" actions={<Button variant="primary" onClick={() => setCreateOpen(true)}><CirclePlus size={17} />新建任务</Button>} />
    <StatsStrip dashboard />
    <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(18rem,.75fr)]">
      <div className="grid gap-4">
        <Card><div className="mb-3 flex items-center"><div><h2 className="font-semibold">待审批</h2><p className="mt-1 text-sm text-muted">需要人工确认的交付与采纳会集中出现在这里</p></div><Link to="/approvals" className="ml-auto shrink-0 whitespace-nowrap text-sm text-brand-soft hover:underline">审批工作台 →</Link></div>
          {tasks.isLoading ? <Spinner /> : review.length ? <div className="grid gap-2">{review.map(task => <DashCard key={task.id} task={task} onOpen={() => openTask(task.id)} actions={<>
            <Button size="sm" variant="primary" disabled={mutateStatus.isPending} onClick={() => mutateStatus.mutate({ id: task.id, status: "succeeded", revision: task.revision })}><Check size={14} />通过并合并</Button>
            <Button size="sm" onClick={() => openTask(task.id)}>驳回</Button>
            <Button size="sm" variant="ghost" onClick={() => openTask(task.id)}>查看详情</Button>
          </>} />)}</div> : <Empty title="当前无需审批" copy="需要人工确认的交付会集中出现在这里。" />}
        </Card>
        <Card><div className="mb-3 flex items-center"><div><h2 className="font-semibold">执行队列</h2><p className="mt-1 text-sm text-muted">创建任务后，进度会在这里实时更新</p></div><span className="ml-auto text-sm text-faint">{running.length} 个进行中</span></div>
          {tasks.isLoading ? <Spinner /> : running.length ? <div className="grid gap-2">{running.map(task => <DashCard key={task.id} task={task} onOpen={() => openTask(task.id)} />)}</div> : <Empty title="执行队列已清空" copy="创建任务后，进度会在这里实时更新。" action={<Button size="sm" onClick={() => setCreateOpen(true)}>派发任务</Button>} />}
        </Card>
      </div>
      <div className="grid content-start gap-3">
        <Card><h2 className="font-semibold">项目进展</h2>
          {projects.isLoading ? <Spinner /> : !activeProjects.length ? <div className="dash-onboard mt-3"><div className="ob-title">开始第一次交付</div>
            <Link className="ob-step" to="/roles"><b>01</b><span>创建任务角色</span></Link>
            <Link className="ob-step" to="/projects"><b>02</b><span>建立项目工作区</span></Link>
            <Link className="ob-step" to="/board"><b>03</b><span>派发首个任务</span></Link>
          </div> : <div className="mt-2 grid gap-2">{visible.map(({ p, pct, inflight }) => <Link key={p.id} className="dash-proj" to={`/projects/${p.id}`}>
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
