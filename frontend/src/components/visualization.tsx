import type { VisualizationSpec } from "../types";
import { Badge, Card } from "./ui";

export function Visualization({ spec }: { spec: VisualizationSpec }) {
  if (spec.version !== 1) return <p className="text-sm text-danger">不支持的可视化版本</p>;
  if (spec.type === "metric") return <Card><div className="text-sm text-muted">{spec.title}</div><div className="mt-2 text-3xl font-semibold">{spec.value}<small className="ml-1 text-sm text-muted">{spec.unit}</small></div></Card>;
  if (spec.type === "table") return <Card><h3 className="mb-4 font-semibold">{spec.title}</h3><div className="overflow-auto"><table className="w-full text-left text-sm"><thead><tr>{spec.columns.map(column => <th className="border-b border-line p-2 text-muted" key={column}>{column}</th>)}</tr></thead><tbody>{spec.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td className="border-b border-line p-2" key={j}>{cell}</td>)}</tr>)}</tbody></table></div></Card>;
  if (spec.type === "timeline") return <Card><h3 className="mb-4 font-semibold">{spec.title}</h3><ol className="grid gap-3">{spec.items.map((item, i) => <li key={`${item.at}-${i}`} className="flex gap-3"><time className="w-32 shrink-0 text-xs text-muted">{item.at}</time><span>{item.label}</span>{item.status && <Badge>{item.status}</Badge>}</li>)}</ol></Card>;
  if (spec.type === "diff_summary") return <Card><h3 className="font-semibold">{spec.title}</h3><div className="mt-4 flex gap-4 text-sm"><span className="text-success">+{spec.added}</span><span className="text-danger">−{spec.removed}</span><span className="text-muted">{spec.files} 个文件</span></div></Card>;
  if (spec.type === "series") {
    const max = Math.max(...spec.points.map(point => point.y), 1);
    return <Card><h3 className="mb-4 font-semibold">{spec.title}</h3><div className="flex min-h-48 items-end gap-2" role="img" aria-label={spec.points.map(point => `${point.x}: ${point.y}${spec.unit || ""}`).join("；")}>{spec.points.map(point => <div key={point.x} className="flex flex-1 flex-col items-center gap-2"><div className="w-full rounded-t bg-brand" style={{ height: `${Math.max(3, point.y / max * 160)}px` }} /><span className="max-w-full truncate text-xs text-muted">{point.x}</span></div>)}</div></Card>;
  }
  return <TaskGraph title={spec.title} nodes={spec.nodes} edges={spec.edges} />;
}

export function TaskGraph({ title, nodes, edges }: { title: string; nodes: Array<{ id: string; label: string; status?: string }>; edges: Array<{ from: string; to: string }> }) {
  const levels = graphLevels(nodes.map(node => node.id), edges);
  return <Card><h3 className="font-semibold">{title}</h3><div className="graph-grid mt-4 overflow-x-auto rounded-xl border border-line p-5" aria-hidden="true"><div className="flex min-w-max gap-10">{levels.map((level, index) => <div className="grid content-center gap-3" key={index}>{level.map(id => { const node = nodes.find(item => item.id === id)!; return <div className="w-48 rounded-xl border border-brand/30 bg-surface p-3 shadow-card" key={id}><div className="text-xs text-brand-soft">{id}</div><div className="mt-1 text-sm font-medium">{node.label}</div>{node.status && <div className="mt-2"><Badge>{node.status}</Badge></div>}</div>; })}</div>)}</div></div><div className="mt-5 overflow-auto"><table className="w-full text-left text-sm"><caption className="sr-only">{title} 的可访问表格视图</caption><thead><tr><th className="border-b border-line p-2">节点</th><th className="border-b border-line p-2">说明</th><th className="border-b border-line p-2">前置节点</th><th className="border-b border-line p-2">状态</th></tr></thead><tbody>{nodes.map(node => <tr key={node.id}><td className="border-b border-line p-2"><code>{node.id}</code></td><td className="border-b border-line p-2">{node.label}</td><td className="border-b border-line p-2">{edges.filter(edge => edge.to === node.id).map(edge => edge.from).join("、") || "—"}</td><td className="border-b border-line p-2">{node.status || "—"}</td></tr>)}</tbody></table></div></Card>;
}

function graphLevels(nodeIDs: string[], edges: Array<{ from: string; to: string }>) {
  const depth = new Map<string, number>();
  const visit = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const parents = edges.filter(edge => edge.to === id).map(edge => edge.from);
    const value = parents.length ? Math.max(...parents.map(parent => visit(parent, new Set(seen)))) + 1 : 0;
    depth.set(id, value);
    return value;
  };
  nodeIDs.forEach(id => visit(id));
  const levels: string[][] = [];
  nodeIDs.forEach(id => (levels[depth.get(id) || 0] ||= []).push(id));
  return levels;
}
