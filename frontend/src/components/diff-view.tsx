// 任务 diff 可视化审查器（自旧前端 task-diff.js 一比一移植）：
// 解析 unified diff → 文件列表（折叠）+ 逐文件行号视图 + 大 hunk 上下文折叠。
// 待审批任务在顶部显示审批操作条（批准/驳回，带修改意见输入）。
import { useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, X } from "lucide-react";
import { api, keys } from "../lib/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, inputClass, useToast } from "./ui";

export interface DiffHunkLine { kind: "add" | "del" | "ctx"; text: string }
export interface DiffHunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: DiffHunkLine[] }
export interface DiffFile { name: string; oldName: string; status: "A" | "D" | "M" | "R"; added: number; removed: number; hunks: DiffHunk[] }

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  const lines = String(text || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("diff --git")) {
      if (cur) files.push(cur);
      cur = { name: "", oldName: "", status: "M", added: 0, removed: 0, hunks: [] };
      const m = /diff --git a\/(\S+) b\/(\S+)/.exec(l);
      if (m) { cur.oldName = m[1]; cur.name = m[2]; }
      continue;
    }
    if (!cur) continue;
    if (l.startsWith("new file")) { cur.status = "A"; cur.name = cur.name || lines[i + 1]?.replace(/^.*\s/, ""); continue; }
    if (l.startsWith("deleted file")) { cur.status = "D"; continue; }
    if (l.startsWith("rename")) { cur.status = "R"; continue; }
    if (l.startsWith("index ") || l.startsWith("--- ") || l.startsWith("+++ ") || l.startsWith("Binary") || l.startsWith("similarity") || l.startsWith("dissimilarity")) continue;
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (h) {
      cur.hunks.push({ oldStart: +h[1], oldLines: h[2] ? +h[2] : 1, newStart: +h[3], newLines: h[4] ? +h[4] : 1, lines: [] });
      continue;
    }
    const hunk = cur.hunks[cur.hunks.length - 1];
    if (!hunk) continue;
    if (l.startsWith("+")) { hunk.lines.push({ kind: "add", text: l.slice(1) }); cur.added++; }
    else if (l.startsWith("-")) { hunk.lines.push({ kind: "del", text: l.slice(1) }); cur.removed++; }
    else if (l.startsWith(" ")) hunk.lines.push({ kind: "ctx", text: l.slice(1) });
    else hunk.lines.push({ kind: "ctx", text: l });
  }
  if (cur) files.push(cur);
  return files;
}

const STATUS_TEXT: Record<string, string> = { A: "新增", D: "删除", R: "改名", M: "修改" };
const MAX_CTX = 16;

function DiffRows({ hunk, expanded, onExpandAll }: { hunk: DiffHunk; expanded: boolean; onExpandAll(): void }) {
  const rows: React.ReactNode[] = [];
  let oldN = hunk.oldStart;
  let newN = hunk.newStart;
  let ctxRun: Array<{ line: DiffHunkLine; old: number; new: number }> = [];
  let key = 0;
  const flushCtx = () => {
    if (!ctxRun.length) return;
    if (!expanded && ctxRun.length > MAX_CTX) {
      rows.push(<tr key={`fold-${key++}`}><td className="fold" colSpan={2} onClick={onExpandAll} role="button" tabIndex={0}>⋯ 上下文折叠 {ctxRun.length} 行（点击展开全部）⋯</td></tr>);
    } else {
      for (const item of ctxRun) {
        rows.push(<tr key={`row-${key++}`} className={item.line.kind}><td className="ln">{item.old || ""}</td><td className="ln">{item.new || ""}</td><td className="tx">{item.line.text}</td></tr>);
      }
    }
    ctxRun = [];
  };
  for (const line of hunk.lines) {
    if (line.kind === "ctx") {
      ctxRun.push({ line, old: oldN, new: newN });
      oldN++; newN++;
      if (ctxRun.length > MAX_CTX) flushCtx();
      continue;
    }
    flushCtx();
    if (line.kind === "add") { rows.push(<tr key={`add-${key++}`} className="add"><td className="ln" /><td className="ln">{newN++}</td><td className="tx">{line.text}</td></tr>); }
    else if (line.kind === "del") { rows.push(<tr key={`del-${key++}`} className="del"><td className="ln">{oldN++}</td><td className="ln" /><td className="tx">{line.text}</td></tr>); }
  }
  flushCtx();
  return <>{rows}</>;
}

export function DiffView({ taskId, status, stat, diff, note }: { taskId: number; status: string; stat?: string; diff: string; note?: string }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const [open, setOpen] = useState<Set<string>>(() => {
    const set = new Set<string>();
    for (const file of parseUnifiedDiff(diff)) {
      set.add(file.name);
      if (file.added + file.removed > 60 || file.hunks.length > 3) set.delete(file.name);
    }
    return set;
  });
  const [expandedHunks, setExpandedHunks] = useState<Set<string>>(new Set());
  const [reviewNote, setReviewNote] = useState("");
  const mutate = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(`/tasks/${taskId}`, { method: "PATCH", body }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: keys.task(taskId) }); queryClient.invalidateQueries({ queryKey: keys.tasks }); },
    onError: error => toast((error as Error).message, "bad")
  });
  if (!files.length) return <p className="text-sm text-muted">无文件改动或非 git 仓库{note ? `（${note}）` : ""}</p>;
  const totalAdd = files.reduce((sum, file) => sum + file.added, 0);
  const totalDel = files.reduce((sum, file) => sum + file.removed, 0);
  const toggleFile = (name: string) => setOpen(prev => { const next = new Set(prev); if (next.has(name)) next.delete(name); else next.add(name); return next; });
  const toggleAll = (value: boolean) => setOpen(new Set(value ? files.map(file => file.name) : []));
  const toggleHunk = (file: string, hunkIndex: number) => {
    const key = `${file}#${hunkIndex}`;
    setExpandedHunks(prev => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  };
  return <div className="diff-view">
    <div className="mb-2 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2 text-sm">
      <span className="text-muted">{files.length} 个文件 · <span className="font-bold text-success">+{totalAdd}</span> <span className="font-bold text-danger">-{totalDel}</span></span>
      {stat && <code className="max-w-full truncate text-xs text-faint">{stat}</code>}
      <span className="ml-auto flex gap-1">
        <Button size="sm" variant="ghost" onClick={() => toggleAll(true)}>全部展开</Button>
        <Button size="sm" variant="ghost" onClick={() => toggleAll(false)}>全部折叠</Button>
      </span>
    </div>
    {status === "awaiting_review" && <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-warning/40 bg-warning/5 px-3 py-2">
      <span className="text-sm text-muted">⏳ 待审批 — 请审查下方 diff 后决定</span>
      <span className="ml-auto flex flex-wrap items-center gap-2">
        <input className={inputClass + " w-64 min-w-0"} placeholder="驳回时填写修改意见…" value={reviewNote} onChange={event => setReviewNote(event.target.value)} aria-label="驳回修改意见" />
        <Button variant="danger" size="sm" disabled={mutate.isPending} onClick={() => { if (!reviewNote.trim()) { toast("请填写修改意见", "bad"); return; } mutate.mutate({ status: "queued", review_note: reviewNote }); }}><X size={14} />驳回</Button>
        <Button variant="primary" size="sm" disabled={mutate.isPending} onClick={() => mutate.mutate({ status: "succeeded" })}><Check size={14} />批准合并</Button>
      </span>
    </div>}
    <div className="grid gap-2">
      {files.map(file => {
        const isOpen = open.has(file.name);
        return <div key={file.name} className="rounded-xl border border-line bg-surface">
          <button type="button" className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm hover:bg-hover" onClick={() => toggleFile(file.name)}>
            {isOpen ? <ChevronDown size={15} className="shrink-0 text-faint" /> : <ChevronRight size={15} className="shrink-0 text-faint" />}
            <span className={`status st-${file.status}`}>{STATUS_TEXT[file.status]}</span>
            <span className="min-w-0 flex-1 truncate font-mono" title={file.name}>{file.name}</span>
            <span className="text-xs text-muted">+{file.added} -{file.removed}</span>
            <span className="text-xs text-faint">{file.hunks.length} 段</span>
          </button>
          {isOpen && file.hunks.map((hunk, hunkIndex) => {
            const hunkKey = `${file.name}#${hunkIndex}`;
            const expanded = expandedHunks.has(hunkKey);
            return <div key={hunkKey} className="diff-hunk">
              <div className="flex items-center gap-2 border-t border-line bg-elevated px-3 py-1 text-xs text-faint">
                <span className="font-mono">@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</span>
                <button type="button" className="ml-auto text-muted hover:text-ink" onClick={() => toggleHunk(file.name, hunkIndex)}>{expanded ? "折叠上下文" : "展开上下文"}</button>
              </div>
              <table className="diff-table"><tbody><DiffRows hunk={hunk} expanded={expanded} onExpandAll={() => toggleHunk(file.name, hunkIndex)} /></tbody></table>
            </div>;
          })}
        </div>;
      })}
    </div>
  </div>;
}
