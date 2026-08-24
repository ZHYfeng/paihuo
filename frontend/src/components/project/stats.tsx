import { useMemo } from "react";
import { STATUS_LABEL, ST_COLOR } from "../../lib/taskmeta";
import type { DailyCount, StatusCount } from "../../types";

export function DailyChart({ daily, days }: { daily: DailyCount[]; days: number }) {
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

export function StatusBarHTML({ counts }: { counts: StatusCount[] }) {
  const order = ["queued", "claimed", "running", "awaiting_review", "succeeded", "failed", "cancelled"];
  const total = (counts || []).reduce((sum, item) => sum + item.count, 0);
  if (!total) return <div className="status-bar" />;
  return <div className="status-bar">{[...(counts || [])].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status)).filter(item => item.count > 0).map(item => <div key={item.status} className="sb-seg" title={`${STATUS_LABEL[item.status] || item.status}: ${item.count}`} style={{ width: `${item.count / total * 100}%`, background: ST_COLOR[item.status] }} />)}</div>;
}
