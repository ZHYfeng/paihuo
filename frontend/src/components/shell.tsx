import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowUpRight, Boxes, CalendarClock, ChevronRight, CircleUserRound, ClipboardCheck, Command, FileText, FolderKanban, Gauge, History, LogOut, Menu, MessagesSquare, Moon, PackageOpen, PanelTop, Search, Settings, Sun, Workflow, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { api, keys } from "../lib/api";
import { useEventStream } from "../lib/events";
import type { OverviewStats, Project, Task } from "../types";
import { cn, Dialog, Spinner } from "./ui";

const groups = [
  { label: "工作空间", items: [
    ["/", "工作台", Gauge], ["/projects", "项目", FolderKanban], ["/board", "任务", PanelTop], ["/approvals", "审批", ClipboardCheck]
  ]},
  { label: "协作与自动化", items: [
    ["/sessions", "会话", MessagesSquare], ["/workflows", "工作流", Workflow], ["/schedules", "定时", CalendarClock], ["/history", "历史", History]
  ]},
  { label: "资源管理", items: [
    ["/runtimes", "运行环境", Boxes], ["/roles", "角色", CircleUserRound], ["/skills", "技能", PackageOpen], ["/templates", "模板", FileText]
  ]}
] as const;
const navigation = [...groups.flatMap(group => [...group.items]), ["/settings", "设置", Settings] as const];

export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [dark, setDark] = useState(() => localStorage.getItem("paihuo:theme") === "dark");
  const browserAuth = document.querySelector<HTMLMetaElement>('meta[name="paihuo-browser-auth"]')?.content !== "disabled";
  const events = useEventStream();
  const stats = useQuery({ queryKey: keys.stats, queryFn: () => api<OverviewStats>("/stats/overview") });
  const reviews = stats.data?.status_counts?.find(item => item.status === "awaiting_review")?.count || 0;
  const location = useLocation();
  const current = navigation.find(([path]) => path === "/" ? location.pathname === "/" : location.pathname.startsWith(path));
  const currentLabel = current?.[1] || (location.pathname.startsWith("/tasks/") ? "任务详情" : "工作空间");

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("paihuo:theme", dark ? "dark" : "light");
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#181b20" : "#f6f6f3");
  }, [dark]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest(".xterm")) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(value => !value);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  useEffect(() => { document.title = `${currentLabel} · 派活 PaiHuo`; }, [currentLabel]);
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1024px)");
    const closeDrawer = () => { if (desktop.matches) setMobileOpen(false); };
    desktop.addEventListener("change", closeDrawer);
    return () => desktop.removeEventListener("change", closeDrawer);
  }, []);

  const nav = <>
    <Link to="/" className="app-brand" onClick={() => setMobileOpen(false)} aria-label="派活 PaiHuo 工作台">
      <span className="brand-mark"><Command size={23} strokeWidth={2.3} /></span>
      <span><b>派活<span>PAIHUO</span></b><small>让想法，成为交付。</small></span>
    </Link>
    <div className="workspace-label"><span className="workspace-avatar">P</span><span>我的工作空间<small>个人 · 本机部署</small></span><span className="workspace-local">LOCAL</span></div>
    <nav className="app-navigation" aria-label="主导航">
      {groups.map(group => <div className="nav-group" key={group.label}>
        <div className="nav-group-label">{group.label}</div>
        {group.items.map(([to, label, Icon]) => <NavLink key={to} to={to} end={to === "/"} onClick={() => setMobileOpen(false)} className={({ isActive }) => cn("nav-item", isActive && "is-active")}>
          <Icon size={17} aria-hidden="true" /><span>{label}</span>
          {to === "/approvals" && reviews > 0 ? <span className="nav-count">{reviews}</span> : null}
        </NavLink>)}
      </div>)}
    </nav>
    <div className="sidebar-bottom">
      <NavLink to="/settings" onClick={() => setMobileOpen(false)} className={({ isActive }) => cn("nav-item", isActive && "is-active")}><Settings size={17} />设置</NavLink>
      <div className="connection-card">
        <span className={cn("connection-dot", events.state)} aria-hidden="true" />
        <span>{events.state === "live" ? "实时连接正常" : events.state === "offline" ? "连接中断" : "正在连接"}<small>{events.state === "live" ? "工作进展持续同步" : "自动重试连接中"}</small></span>
        {browserAuth ? <form action="/logout" method="post"><button className="sidebar-logout" aria-label="退出登录" title="退出登录"><LogOut size={16} /></button></form> : null}
      </div>
    </div>
  </>;

  return <div className="app-shell">
    <a href="#main-content" className="sr-only z-[100] rounded-lg bg-brand px-4 py-2 text-white focus:not-sr-only focus:fixed focus:left-4 focus:top-4">跳到主要内容</a>
    <aside className="app-sidebar">{nav}</aside>
    <DialogPrimitive.Root open={mobileOpen} onOpenChange={setMobileOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/45 backdrop-blur-sm lg:hidden" />
        <DialogPrimitive.Content className="mobile-sidebar lg:hidden" aria-describedby={undefined}>
          <DialogPrimitive.Title className="sr-only">工作空间导航</DialogPrimitive.Title>
          <DialogPrimitive.Close className="mobile-nav-close" aria-label="关闭导航"><X size={18} /></DialogPrimitive.Close>
          {nav}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
    <div className="app-workspace">
      <header className="workspace-topbar">
        <button className="icon-button mobile-menu" onClick={() => setMobileOpen(true)} aria-label="打开导航"><Menu size={19} /></button>
        <div className="workspace-breadcrumb"><span>工作空间</span><ChevronRight size={13} /><b>{currentLabel}</b></div>
        <div className="topbar-actions">
          <button className="global-search" onClick={() => setSearchOpen(true)} aria-label="搜索任务、项目或页面"><Search size={15} /><span>搜索工作空间</span><kbd>⌘ / Ctrl K</kbd></button>
          <span className="topbar-divider" />
          <button onClick={() => setDark(value => !value)} className="icon-button" aria-label={dark ? "切换到亮色" : "切换到暗色"} title={dark ? "切换到亮色" : "切换到暗色"}>{dark ? <Sun size={17} /> : <Moon size={17} />}</button>
          <Link to="/approvals" className="icon-button approval-shortcut" aria-label={`待审批 ${reviews} 项`} title="待审批"><ClipboardCheck size={18} />{reviews > 0 && <i />}</Link>
          <span className="profile-avatar" title="个人工作空间">P</span>
        </div>
      </header>
      <main id="main-content" className="workspace-main"><Outlet /></main>
      <footer className="workspace-footer"><span>PAIHUO <span className="footer-dot">·</span> 让每一次派活都有着落</span><span>你的项目，你的节奏。</span></footer>
    </div>
    {searchOpen && <WorkspaceSearch onClose={() => setSearchOpen(false)} />}
  </div>;
}

function WorkspaceSearch({ onClose }: { onClose(): void }) {
  const [search, setSearch] = useState("");
  const resultsRef = useRef<HTMLDivElement>(null);
  const resultLinks = () => Array.from(resultsRef.current?.querySelectorAll<HTMLAnchorElement>("a[href]") || []);
  const tasks = useQuery({ queryKey: [...keys.tasks, "workspace-search"], queryFn: async () => {
    const groups = await Promise.all(["/tasks", "/tasks?type=session", "/tasks?type=workflow", "/tasks?scheduled=1"].map(path => api<Task[]>(path)));
    return [...new Map(groups.flatMap(items => items || []).map(task => [task.id, task])).values()];
  } });
  const projects = useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/projects") });
  const term = search.trim().toLocaleLowerCase();
  const pages = navigation.filter(([, label]) => !term || label.includes(term)).slice(0, 5);
  const matchedProjects = term ? (projects.data || []).filter(project => project.name.toLocaleLowerCase().includes(term)).slice(0, 4) : [];
  const matchedTasks = term ? (tasks.data || []).filter(task => `${task.title} #${task.id}`.toLocaleLowerCase().includes(term)).slice(0, 6) : [];
  const loading = tasks.isLoading || projects.isLoading;
  return <Dialog open onOpenChange={open => !open && onClose()} title="搜索工作空间" description="查找任务、项目，或快速前往页面。">
    <div className="search-input-wrap"><Search size={18} /><input autoFocus value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => {
      if (["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) {
        event.preventDefault();
        const links = resultLinks();
        if (event.key === "Enter") links[0]?.click();
        else (event.key === "ArrowUp" ? links.at(-1) : links[0])?.focus();
      }
    }} placeholder="输入名称或任务编号…" aria-label="搜索工作空间内容" /></div>
    <div className="search-results" ref={resultsRef} onKeyDown={event => {
      if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
      const links = resultLinks();
      if (!links.length) return;
      event.preventDefault();
      const current = links.findIndex(link => link === document.activeElement);
      links[(current + (event.key === "ArrowUp" ? -1 : 1) + links.length) % links.length]?.focus();
    }}>
      {pages.length > 0 && <div className="search-group-title">快速导航</div>}
      {pages.map(([to, label, Icon]) => <Link className="search-result" key={to} to={to} onClick={onClose}><Icon size={17} /><span>{label}</span><ArrowUpRight size={14} /></Link>)}
      {matchedProjects.length > 0 && <div className="search-group-title">项目</div>}
      {matchedProjects.map(project => <Link className="search-result" key={project.id} to={`/projects/${project.id}`} onClick={onClose}><FolderKanban size={17} /><span>{project.name}</span><ArrowDownLeft size={14} /></Link>)}
      {matchedTasks.length > 0 && <div className="search-group-title">任务</div>}
      {matchedTasks.map(task => <Link className="search-result" key={task.id} to={task.cron ? "/schedules" : `/${task.type === "session" ? "sessions" : task.type === "workflow" ? "workflows" : "tasks"}/${task.id}`} onClick={onClose}><PanelTop size={17} /><span>{task.title}<small>#{task.id} · {task.project_name || "未绑定项目"}</small></span><ArrowDownLeft size={14} /></Link>)}
      {term && loading && <Spinner label="正在查找" />}
      {term && !loading && !pages.length && !matchedProjects.length && !matchedTasks.length && <p className="search-empty">没有找到“{search}”，试试其他关键词。</p>}
      {(tasks.isError || projects.isError) && <p className="search-empty text-danger">部分内容加载失败，请稍后重试。</p>}
    </div>
  </Dialog>;
}

export function PageHeader({ title, copy, actions }: { title: string; copy?: string; actions?: ReactNode }) {
  return <header className="page-header">
    <div className="min-w-0"><h1>{title}</h1>{copy && <p>{copy}</p>}</div>
    {actions && <div className="page-header-actions">{actions}</div>}
  </header>;
}
