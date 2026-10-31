import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, CheckCheck, ClipboardCheck, Layers3, Target } from "lucide-react";
import { Link } from "react-router-dom";
import { api, keys } from "../../lib/api";
import { fmtDur, fmtPct } from "../../lib/taskmeta";
import type { OverviewStats } from "../../types";

export function StatsStrip({ dashboard = false }: { dashboard?: boolean }) {
  const stats = useQuery({ queryKey: keys.stats, queryFn: () => api<OverviewStats>("/stats/overview") });
  const counts = stats.data?.status_counts || [];
  const review = counts.find(s => s.status === "awaiting_review")?.count || 0;
  const today = stats.data?.daily?.find(day => day.date === new Date().toISOString().slice(0, 10))?.count || 0;
  const queued = counts.filter(s => ["queued", "claimed", "running"].includes(s.status)).reduce((sum, s) => sum + s.count, 0);
  const ready = stats.isSuccess;
  const metrics = [
    { label: "执行队列", value: queued, hint: "排队与执行中的任务", tone: "blue", Icon: Layers3, to: "/board" },
    { label: "待你审批", value: review, hint: review ? "交付已就绪，等待你确认" : "所有交付均已处理", tone: "amber", Icon: ClipboardCheck, to: "/approvals" },
    { label: "今日完成", value: today, hint: "按 UTC 日期统计", tone: "green", Icon: CheckCheck, to: "/history" },
    { label: "完成率", value: fmtPct(stats.data?.success_rate || 0), hint: "已完成任务占全部任务的比例", tone: "violet", Icon: Target, to: "/history" }
  ];
  if (dashboard) return <div className="overview-metrics" aria-label="工作空间概览">
    {metrics.map(({ label, value, hint, tone, Icon, to }) => <Link key={label} className={`overview-metric ${tone}`} to={to}>
      <div className="metric-top"><span>{label}</span><span className="metric-icon"><Icon size={17} /></span></div>
      <div className="metric-value">{ready ? value : "—"}<ArrowUpRight size={17} /></div>
      <div className="metric-hint">{stats.isError ? "暂时无法获取数据" : hint}</div>
    </Link>)}
  </div>;
  const chips: Array<[string, string | number, string]> = [
    ["执行队列", queued, "var(--st-running)"],
    ["待审批", review, "var(--st-review)"],
    ["今日完成", today, "var(--st-done)"],
    ["完成率", fmtPct(stats.data?.success_rate || 0), "var(--st-done)"],
    ["平均耗时", fmtDur(stats.data?.avg_duration || 0), "var(--muted)"],
    ["活跃项目", stats.data?.projects || 0, "var(--muted)"]
  ];
  return <div className="stat-strip">{chips.map(([label, value, color]) => <div key={label} className="stat-chip" aria-label={`${label} ${ready ? value : "暂不可用"}`}>
    <span className="sc-dot" style={{ background: color }} /><b>{ready ? value : "—"}</b><span className="sc-label">{label}</span>
  </div>)}</div>;
}
