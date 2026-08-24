import { useQuery } from "@tanstack/react-query";
import { api, keys } from "../../lib/api";
import { fmtDur, fmtPct } from "../../lib/taskmeta";
import type { OverviewStats } from "../../types";

export function StatsStrip({ dashboard = false }: { dashboard?: boolean }) {
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
    ["平均耗时", fmtDur(stats.data?.avg_duration || 0), "var(--muted)"],
    ["活跃项目", stats.data?.projects || 0, "var(--muted)"]
  ];
  const visible = dashboard ? [chips[1], chips[0], chips[2], chips[3]] : chips;
  return <div className="stat-strip">{visible.map(([label, value, color]) => <div key={label} className="stat-chip" aria-label={`${label} ${value}`}>
    <span className="sc-dot" style={{ background: color }} /><b>{value}</b><span className="sc-label">{label}</span>
  </div>)}</div>;
}

/* ---- 卡片 chips（旧 task.js cardHTML） ---- */
