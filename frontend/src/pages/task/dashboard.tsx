import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ArrowUpRight, Boxes, CalendarDays, CheckCheck, ChevronRight, CirclePlus, ClipboardCheck, FolderKanban, Layers3, MessagesSquare, Workflow } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "../../components/shell";
import { DashCard } from "../../components/task/task-card";
import { NewTaskDialog } from "../../components/task/create-dialog";
import { StatsStrip } from "../../components/task/stats-strip";
import { TaskStatus } from "../../components/task/status";
import { formatTime } from "../../components/task/format";
import { Button, Card, Empty, Spinner } from "../../components/ui";
import { useHotkeys } from "../../lib/hotkeys";
import { api, keys } from "../../lib/api";
import type { OverviewStats, Project, ProvisionInfo, Role } from "../../types";
import { useTasks } from "../../hooks/useTasks";

export function DashboardPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const [queueView, setQueueView] = useState("all");
  const tasks = useTasks();
  const projects = useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/projects") });
  const roles = useQuery({ queryKey: keys.roles, queryFn: () => api<Role[]>("/roles") });
  const provisioning = useQuery({ queryKey: keys.provisioning, queryFn: () => api<ProvisionInfo[]>("/runtimes/provisioning") });
  const stats = useQuery({ queryKey: keys.stats, queryFn: () => api<OverviewStats>("/stats/overview") });
  useHotkeys({ newTask: () => setCreateOpen(true), enabled: !createOpen });
  const all = (tasks.data || []).filter(task => task.type === "task" && !task.cron);
  const queue = all.filter(task => ["queued", "claimed", "running"].includes(task.status)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const running = queue.filter(task => task.status !== "queued");
  const waiting = queue.filter(task => task.status === "queued");
  const visibleQueue = (queueView === "running" ? running : queueView === "queued" ? waiting : queue).slice(0, 5);
  const review = all.filter(task => task.status === "awaiting_review").sort((a, b) => b.created_at.localeCompare(a.created_at));
  const recent = all.filter(task => ["succeeded", "failed", "cancelled"].includes(task.status)).sort((a, b) => (b.finished_at || b.updated_at).localeCompare(a.finished_at || a.updated_at)).slice(0, 4);
  const activeProjects = projects.data?.filter(project => project.status === "active") || [];
  const ranked = activeProjects.map(project => {
    const projectTasks = all.filter(task => task.project_id === project.id);
    const done = projectTasks.filter(task => task.status === "succeeded").length;
    const active = projectTasks.filter(task => ["queued", "claimed", "running", "awaiting_review"].includes(task.status)).length;
    return { project, total: projectTasks.length, done, active, pct: projectTasks.length ? Math.round(done / projectTasks.length * 100) : 0 };
  }).sort((a, b) => b.active - a.active || a.project.name.localeCompare(b.project.name, "zh-CN"));
  const installed = provisioning.data?.filter(runtime => runtime.installed) || [];
  const now = new Date();
  const days = Array.from({ length: 14 }, (_, index) => {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() - (13 - index));
    const key = date.toISOString().slice(0, 10);
    return { date: key, count: stats.data?.daily?.find(day => day.date === key)?.count || 0 };
  });
  const maxDaily = Math.max(...days.map(day => day.count), 1);

  return <>
    <div className="dashboard-eyebrow"><span>你的工作，一目了然</span><span><CalendarDays size={14} />{now.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" })}</span></div>
    <PageHeader title="工作台" copy="掌握项目进展，专注下一次交付。" actions={<><Link className="quick-workflow-link" to="/workflows"><Workflow size={16} />工作流<ArrowUpRight size={13} /></Link><Button variant="primary" onClick={() => setCreateOpen(true)}><CirclePlus size={17} />新建任务<kbd className="button-key">N</kbd></Button></>} />
    <StatsStrip dashboard />
    {tasks.isError && <div className="dashboard-error" role="alert">任务加载失败：{tasks.error.message}<Button size="sm" onClick={() => tasks.refetch()}>重试</Button></div>}
    <div className="dashboard-grid">
      <div className="dashboard-primary">
        <Card className="dashboard-panel queue-panel">
          <div className="panel-heading"><span className="panel-icon"><Layers3 size={18} /></span><h2>执行队列</h2><span className="panel-count">{queue.length}</span><Link to="/board" className="panel-link">查看全部<ArrowUpRight size={14} /></Link></div>
          <div className="queue-tabs" role="group" aria-label="筛选执行队列">{[["all", "全部", queue.length], ["running", "执行中", running.length], ["queued", "排队中", waiting.length]].map(([value, label, count]) => <button key={value} onClick={() => setQueueView(String(value))} aria-pressed={queueView === value} className={queueView === value ? "is-active" : ""}>{label}<span>{count}</span></button>)}</div>
          {tasks.isLoading ? <Spinner /> : visibleQueue.length ? <div className="queue-list">{visibleQueue.map(task => <DashCard key={task.id} task={task} />)}</div> : <Empty title={queue.length ? "这个队列暂时没有任务" : "准备好，开始下一次交付"} copy={queue.length ? "切换队列查看其他任务。" : "把想完成的事交给合适的角色，执行进展会在这里实时呈现。"} action={<Button size="sm" onClick={() => setCreateOpen(true)}><CirclePlus size={15} />派发一个任务</Button>} />}
          <div className="panel-footnote"><span className="live-indicator" />任务状态自动同步<Link to="/sessions"><MessagesSquare size={14} />需要先探索？开启会话<ChevronRight size={12} /></Link></div>
        </Card>
        <Card className="dashboard-panel delivery-panel">
          <div className="panel-heading"><span className="panel-icon green"><CheckCheck size={18} /></span><h2>最近交付</h2><Link to="/history" className="panel-link">全部历史<ArrowUpRight size={14} /></Link></div>
          <div className="delivery-summary"><div><span>近 14 天完成</span><strong>{stats.isSuccess ? days.reduce((sum, day) => sum + day.count, 0) : "—"}<small>个任务</small></strong></div><div className="delivery-chart" role="img" aria-label={stats.isSuccess ? `近14天每日完成任务数（UTC）：${days.map(day => `${day.date} ${day.count}个`).join("，")}` : "交付趋势暂不可用"}>{days.map(day => <div key={day.date} className={day.count ? "has-value" : ""} style={{ height: `${Math.max(day.count / maxDaily * 100, 5)}%` }} title={`${day.date}：${day.count} 个完成（UTC）`} />)}</div></div>
          {tasks.isLoading ? <Spinner /> : recent.length ? <div className="recent-deliveries">{recent.map(task => <Link key={task.id} to={`/tasks/${task.id}`} className="delivery-row"><span className="delivery-id">#{task.id}</span><span className="delivery-task"><b>{task.title}</b><small>{task.project_name || "未绑定项目"} · {formatTime(task.finished_at || task.updated_at)}</small></span><TaskStatus status={task.status} /><ChevronRight size={14} /></Link>)}</div> : <div className="quiet-empty">每一份交付都会记录在这里。</div>}
        </Card>
      </div>
      <div className="dashboard-secondary">
        <Card className={`dashboard-panel review-panel ${review.length ? "has-reviews" : ""}`}>
          <div className="panel-heading"><span className="panel-icon amber"><ClipboardCheck size={18} /></span><h2>需要你关注</h2><span className="attention-dot" /></div>
          {tasks.isLoading ? <Spinner /> : review.length ? <><div className="review-summary"><strong>{review.length}</strong><div><b>份交付等待审批</b><span>审查成果，推动项目继续前进。</span></div></div><div className="review-preview">{review.slice(0, 2).map(task => <Link key={task.id} to={`/tasks/${task.id}`}><span>#{task.id}</span><b>{task.title}</b><ChevronRight size={14} /></Link>)}</div><Link to="/approvals" className="review-action">前往审批<ArrowRight size={15} /></Link></> : <div className="review-clear"><CheckCheck size={25} strokeWidth={1.5} /><b>一切就绪</b><p>当前没有等待审批的交付。</p><Link to="/approvals">查看审批<ArrowRight size={13} /></Link></div>}
        </Card>
        <Card className="dashboard-panel projects-panel">
          <div className="panel-heading"><span className="panel-icon"><FolderKanban size={18} /></span><h2>活跃项目</h2><Link to="/projects" className="panel-link" aria-label="查看全部项目"><ArrowUpRight size={16} /></Link></div>
          {projects.isLoading ? <Spinner /> : ranked.length ? <div className="project-progress-list">{ranked.slice(0, 4).map(({ project, total, done, active, pct }, index) => <Link key={project.id} className="project-progress-item" to={`/projects/${project.id}`}><div className="project-progress-title"><span className={`project-monogram color-${index % 4}`}>{project.name.slice(0, 1).toUpperCase()}</span><b title={project.name}>{project.name}</b>{active > 0 && <span className="project-active">{active} 进行中</span>}</div><div className="project-progress-meta"><span>{done} / {total} 任务已完成</span><b>{pct}%</b></div><div className="pp-bar"><div style={{ width: `${pct}%` }} /></div></Link>)}</div> : projects.isError ? <p className="quiet-empty">项目暂时无法加载。</p> : <div className="dash-onboard"><p>从第一个项目开始</p><Link className="onboard-step" to="/runtimes"><span>01</span>准备运行环境<ChevronRight size={14} /></Link><Link className="onboard-step" to="/roles"><span>02</span>创建任务角色<ChevronRight size={14} /></Link><Link className="onboard-step" to="/projects"><span>03</span>建立项目并派活<ChevronRight size={14} /></Link></div>}
        </Card>
        <Card className="dashboard-panel runtime-panel">
          <div className="panel-heading"><span className="panel-icon"><Boxes size={18} /></span><h2>运行环境</h2><Link to="/runtimes" className="panel-link">管理<ArrowUpRight size={14} /></Link></div>
          {provisioning.isLoading ? <Spinner /> : provisioning.isError ? <p className="quiet-empty">运行环境暂时无法加载。</p> : <><div className="runtime-grid">{provisioning.data?.map(runtime => <span key={runtime.id} className="runtime-item" title={`${runtime.name}${runtime.version ? ` ${runtime.version}` : ""} · ${runtime.installed ? runtime.login ? "已安装并登录" : "已安装，未登录" : "未安装"}`}><i className={runtime.installed ? runtime.login ? "ready" : "installed" : ""} /><span>{runtime.name}</span><span className="sr-only">{runtime.installed ? runtime.login ? "已安装并登录" : "已安装，未登录" : "未安装"}</span></span>)}</div><div className="runtime-summary"><span>{installed.length} / {provisioning.data?.length || 0} 已安装</span><Link to="/roles">{roles.isSuccess ? roles.data.filter(role => role.enabled).length : "—"} 个角色已启用<ChevronRight size={12} /></Link></div></>}
        </Card>
      </div>
    </div>
    <NewTaskDialog open={createOpen} onOpenChange={setCreateOpen} />
  </>;
}
