import { Boxes, CalendarClock, CircleUserRound, ClipboardCheck, FileText, FolderKanban, Gauge, History, Menu, MessagesSquare, Moon, PackageOpen, PanelTop, Settings, Sun, Workflow, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import { useEventStream } from "../lib/events";
import { cn } from "./ui";

const groups = [
  { label: "工作区", items: [
    ["/", "工作台", Gauge], ["/projects", "项目", FolderKanban], ["/board", "任务", PanelTop], ["/sessions", "会话", MessagesSquare], ["/workflows", "工作流", Workflow], ["/schedules", "定时", CalendarClock], ["/approvals", "审批", ClipboardCheck], ["/history", "历史", History]
  ]},
  { label: "资源", items: [
    ["/runtimes", "智能体", Boxes], ["/roles", "角色", CircleUserRound], ["/skills", "技能", PackageOpen], ["/templates", "模板", FileText]
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
    <Link to="/" className="flex items-center gap-2 px-2 py-2" onClick={() => setMobileOpen(false)}>
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-brand text-xs font-bold text-white">派</span>
      <b className="block text-[13px] font-semibold tracking-[.14em] text-ink">PAIHUO</b>
    </Link>
    <nav className="mt-2 grid min-h-0 flex-1 content-start gap-2 overflow-y-auto py-1 pr-0.5" aria-label="主导航">
      {groups.map(group => <div key={group.label}>
        <div className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-[.18em] text-faint">{group.label}</div>
        <div className="grid gap-0.5">
          {group.items.map(([to, label, Icon]) => <NavLink key={to} to={to} end={to === "/"} onClick={() => setMobileOpen(false)} className={({ isActive }) => cn(
            "flex min-h-7 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-focus",
            isActive ? "bg-brand/10 text-brand-soft" : "text-muted hover:bg-hover hover:text-ink"
          )}>
            <Icon size={15} aria-hidden="true" /><span>{label}</span>
          </NavLink>)}
        </div>
      </div>)}
    </nav>
    <div className="mt-auto grid gap-1.5 px-2 pb-2 pt-2">
      <div className={cn("flex items-center gap-2 px-1 text-xs", events.state === "live" ? "text-success" : events.state === "offline" ? "text-danger" : "text-warning")} title={events.lastSync?.toLocaleString()}>
        <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
        {events.state === "live" ? "实时连接正常" : events.state === "offline" ? "连接中断，自动重试" : "正在连接"}
      </div>
      <div className="flex gap-1.5">
        <button onClick={() => setDark(value => !value)} className="grid size-7 place-items-center rounded-md text-muted transition-colors hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-focus" aria-label={dark ? "切换到亮色" : "切换到暗色"}>{dark ? <Sun size={14} /> : <Moon size={14} />}</button>
        <form action="/logout" method="post" className="flex-1"><button className="h-7 w-full rounded-md text-[13px] text-muted transition-colors hover:bg-hover hover:text-ink">退出</button></form>
      </div>
    </div>
  </>;

  return <div className="min-h-screen bg-canvas text-ink">
    <a href="#main-content" className="sr-only z-[100] rounded-lg bg-brand px-4 py-2 text-white focus:not-sr-only focus:fixed focus:left-4 focus:top-4">跳到主要内容</a>
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-44 flex-col border-r border-line bg-surface p-2 lg:flex">{nav}</aside>
    {mobileOpen && <div className="fixed inset-0 z-40 bg-slate-950/60 lg:hidden" onClick={() => setMobileOpen(false)} />}
    <aside className={cn("fixed inset-y-0 left-0 z-50 flex w-[min(19rem,88vw)] flex-col border-r border-line bg-surface p-2 transition-transform lg:hidden", mobileOpen ? "translate-x-0" : "-translate-x-full")}>
      <button className="absolute right-2 top-2.5 grid size-8 place-items-center rounded-md text-muted hover:bg-hover" onClick={() => setMobileOpen(false)} aria-label="关闭导航"><X size={16} /></button>{nav}
    </aside>
    <div className="lg:pl-44">
      <header className="sticky top-0 z-20 flex h-[3.25rem] items-center border-b border-line bg-canvas/90 px-3 lg:hidden">
        <button className="grid size-8 place-items-center rounded-lg border border-line" onClick={() => setMobileOpen(true)} aria-label="打开导航"><Menu size={17} /></button>
        <span className="ml-3 font-semibold">派活</span>
      </header>
      <main id="main-content" className="mx-auto min-h-screen w-full max-w-[1600px] p-3 sm:p-4 xl:p-5"><Outlet /></main>
    </div>
  </div>;
}

export function PageHeader({ title, copy, actions }: { title: string; copy?: string; actions?: ReactNode }) {
  return <header className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end">
    <div className="min-w-0">
      <h1 className="text-lg font-bold leading-tight tracking-tight text-ink sm:text-xl">{title}</h1>
      {copy && <p className="mt-1 max-w-2xl text-[13px] leading-5 text-muted">{copy}</p>}
    </div>
    {actions && <div className="flex flex-wrap gap-2 sm:ml-auto">{actions}</div>}
  </header>;
}
