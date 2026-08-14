import { Activity, Boxes, CalendarClock, ChevronRight, CircleUserRound, ClipboardCheck, FileText, FolderKanban, Gauge, History, Menu, MessagesSquare, Moon, PackageOpen, PanelTop, Settings, Sun, Workflow, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import { useEventStream } from "../lib/events";
import { cn } from "./ui";

const groups = [
  { label: "工作区", items: [
    ["/", "工作台", Gauge], ["/board", "任务", PanelTop], ["/sessions", "会话", MessagesSquare], ["/workflows", "工作流", Workflow], ["/schedules", "定时", CalendarClock], ["/approvals", "审批", ClipboardCheck], ["/history", "历史", History]
  ]},
  { label: "资源", items: [
    ["/projects", "项目", FolderKanban], ["/roles", "角色", CircleUserRound], ["/runtimes", "Runtime", Boxes], ["/skills", "技能", PackageOpen], ["/templates", "模板", FileText]
  ]},
  { label: "系统", items: [["/settings", "设置", Settings]] }
] as const;

export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [dark, setDark] = useState(() => localStorage.getItem("paihuo:theme") !== "light");
  const events = useEventStream();
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("paihuo:theme", dark ? "dark" : "light");
  }, [dark]);

  const nav = <>
    <Link to="/" className="flex items-center gap-3 px-3 py-4" onClick={() => setMobileOpen(false)}>
      <span className="grid size-9 place-items-center rounded-xl bg-brand font-bold text-white">派</span>
      <span><b className="block text-sm tracking-wide text-ink">PAIHUO</b><small className="text-xs text-muted">Agent operations</small></span>
    </Link>
    <nav className="mt-3 grid gap-5" aria-label="主导航">
      {groups.map(group => <div key={group.label}>
        <div className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-[.16em] text-faint">{group.label}</div>
        <div className="grid gap-1">
          {group.items.map(([to, label, Icon]) => <NavLink key={to} to={to} end={to === "/"} onClick={() => setMobileOpen(false)} className={({ isActive }) => cn(
            "group flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium text-muted transition-colors focus-visible:ring-2 focus-visible:ring-focus",
            isActive ? "bg-brand/12 text-brand-soft" : "hover:bg-hover hover:text-ink"
          )}>
            <Icon size={18} aria-hidden="true" /><span>{label}</span><ChevronRight size={14} className="ml-auto opacity-0 transition-opacity group-hover:opacity-60" />
          </NavLink>)}
        </div>
      </div>)}
    </nav>
    <div className="mt-auto grid gap-3 px-3 pb-4 pt-8">
      <div className="flex items-center gap-2 text-xs text-muted" title={events.lastSync?.toLocaleString()}>
        <Activity size={14} className={events.state === "live" ? "text-success" : events.state === "offline" ? "text-danger" : "text-warning"} />
        {events.state === "live" ? "实时连接正常" : events.state === "offline" ? "连接中断，自动重试" : "正在连接"}
      </div>
      <div className="flex gap-2">
        <button onClick={() => setDark(value => !value)} className="grid size-10 place-items-center rounded-xl border border-line text-muted hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus" aria-label={dark ? "切换到亮色" : "切换到暗色"}>{dark ? <Sun size={17} /> : <Moon size={17} />}</button>
        <form action="/logout" method="post" className="flex-1"><button className="h-10 w-full rounded-xl border border-line text-sm text-muted hover:bg-hover hover:text-ink">退出</button></form>
      </div>
    </div>
  </>;

  return <div className="min-h-screen bg-canvas text-ink">
    <a href="#main-content" className="sr-only z-[100] rounded-lg bg-brand px-4 py-2 text-white focus:not-sr-only focus:fixed focus:left-4 focus:top-4">跳到主要内容</a>
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-line bg-surface/95 p-3 backdrop-blur lg:flex">{nav}</aside>
    {mobileOpen && <div className="fixed inset-0 z-40 bg-slate-950/60 lg:hidden" onClick={() => setMobileOpen(false)} />}
    <aside className={cn("fixed inset-y-0 left-0 z-50 flex w-[min(19rem,88vw)] flex-col border-r border-line bg-surface p-3 transition-transform lg:hidden", mobileOpen ? "translate-x-0" : "-translate-x-full")}>
      <button className="absolute right-3 top-4 grid size-10 place-items-center rounded-xl text-muted hover:bg-hover" onClick={() => setMobileOpen(false)} aria-label="关闭导航"><X size={18} /></button>{nav}
    </aside>
    <div className="lg:pl-64">
      <header className="sticky top-0 z-20 flex h-16 items-center border-b border-line bg-canvas/85 px-4 backdrop-blur lg:hidden">
        <button className="grid size-10 place-items-center rounded-xl border border-line" onClick={() => setMobileOpen(true)} aria-label="打开导航"><Menu size={19} /></button>
        <span className="ml-3 font-semibold">派活</span>
      </header>
      <main id="main-content" className="mx-auto min-h-screen w-full max-w-[1600px] p-4 sm:p-6 xl:p-8"><Outlet /></main>
    </div>
  </div>;
}

export function PageHeader({ kicker, title, copy, actions }: { kicker: string; title: string; copy?: string; actions?: ReactNode }) {
  return <header className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end">
    <div><div className="text-[11px] font-semibold uppercase tracking-[.2em] text-brand-soft">{kicker}</div><h1 className="mt-1 text-3xl font-semibold tracking-tight text-ink">{title}</h1>{copy && <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">{copy}</p>}</div>
    {actions && <div className="flex flex-wrap gap-2 sm:ml-auto">{actions}</div>}
  </header>;
}
