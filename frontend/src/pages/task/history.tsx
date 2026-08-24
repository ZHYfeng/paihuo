import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListFilter, RotateCcw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "../../components/shell";
import { formatTime } from "../../components/task/format";
import { TaskStatus } from "../../components/task/status";
import { Button, Card, Empty, inputClass, Spinner, useToast } from "../../components/ui";
import { useTasks } from "../../hooks/useTasks";
import { api, keys } from "../../lib/api";
import { PERM_LABEL, STATUS_LABEL, canDeleteTask, canRetryTask, retryTaskLabel } from "../../lib/taskmeta";
import type { Role, Task } from "../../types";

export function HistoryPage() {
  const tasks = useTasks("?limit=500");
  const roles = useQuery({ queryKey: keys.roles, queryFn: () => api<Role[]>("/roles") });
  const qc = useQueryClient();
  const toast = useToast();
  const [roleID, setRoleID] = useState("");
  const [status, setStatus] = useState("");
  const [days, setDays] = useState("");
  const [cutoff, setCutoff] = useState(0);
  const onDaysChange = (value: string) => {
    setDays(value);
    setCutoff(value ? Date.now() - Number(value) * 86400_000 : 0);
  };
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const all = useMemo(() => tasks.data || [], [tasks.data]);
  const terminal = useMemo(() => all.filter(task => ["succeeded", "failed", "cancelled"].includes(task.status)), [all]);
  const filtered = terminal.filter(task => {
    if (roleID && String(task.role_id) !== roleID) return false;
    if (status && task.status !== status) return false;
    if (cutoff) {
      const at = task.finished_at || task.created_at;
      if (at && new Date(at).getTime() < cutoff) return false;
    }
    return true;
  });
  const toggle = (id: number) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setSelected(prev => {
    const eligible = filtered.filter(task => !task.merge_of).map(task => task.id);
    const allPicked = eligible.every(id => prev.has(id));
    const next = new Set(prev);
    if (allPicked) eligible.forEach(id => next.delete(id)); else eligible.forEach(id => next.add(id));
    return next;
  });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["tasks"] }); qc.invalidateQueries({ queryKey: keys.tasks }); qc.invalidateQueries({ queryKey: keys.stats }); };
  const removeSelected = useMutation({
    mutationFn: async () => { const revisions = new Map(all.map(t => [t.id, t.revision])); await Promise.all([...selected].map(id => api(`/tasks/${id}`, { method: "DELETE", revision: revisions.get(id) }))); },
    onSuccess: () => { toast(`已删除 ${selected.size} 条`); setSelected(new Set()); refresh(); },
    onError: error => toast((error as Error).message, "bad")
  });
  const cleanup = useMutation({
    mutationFn: () => api<{ deleted: number }>("/tasks/cleanup", { method: "POST", body: { role_id: roleID ? Number(roleID) : null, before: new Date(cutoff).toISOString() } }),
    onSuccess: data => { toast(`已清理 ${data.deleted} 条历史任务`); setSelected(new Set()); refresh(); },
    onError: error => toast((error as Error).message, "bad")
  });
  const retry = useMutation({
    mutationFn: (task: Task) => api(`/tasks/${task.id}`, { method: "PATCH", revision: task.revision, body: { status: "queued" } }),
    onSuccess: () => { refresh(); toast("已重新排队"); },
    onError: error => toast((error as Error).message, "bad")
  });
  const remove = useMutation({
    mutationFn: (task: Task) => api(`/tasks/${task.id}`, { method: "DELETE", revision: task.revision }),
    onSuccess: () => { refresh(); toast("已删除"); },
    onError: error => toast((error as Error).message, "bad")
  });
  return <>
    <PageHeader title="历史" copy="已结算任务及其退出原因、审批轮次和时间。" />
    <Card className="mb-4 flex flex-col gap-2 p-3 sm:flex-row sm:flex-wrap sm:items-center">
      <span className="flex shrink-0 items-center gap-2 px-2 text-sm text-muted whitespace-nowrap"><ListFilter size={16} />筛选</span>
      <select className={inputClass + " sm:w-40"} value={roleID} onChange={event => setRoleID(event.target.value)} aria-label="按角色筛选"><option value="">全部角色</option>{roles.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <select className={inputClass + " sm:w-36"} value={status} onChange={event => setStatus(event.target.value)} aria-label="按状态筛选"><option value="">全部状态</option>{Object.entries(STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <label className="flex items-center gap-2 whitespace-nowrap text-sm text-muted"><span>天数</span><input type="number" min={1} className={inputClass + " sm:w-24"} value={days} onChange={event => onDaysChange(event.target.value)} placeholder="全部时间" aria-label="按天数筛选" /></label>
      <span className="whitespace-nowrap text-sm text-muted sm:ml-auto">{filtered.length} 条</span>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={toggleAll}>全选非合并</Button>
        <Button size="sm" variant="danger" disabled={!selected.size || removeSelected.isPending} onClick={() => confirm(`删除选中的 ${selected.size} 条历史任务？`) && removeSelected.mutate()}>删除选中{selected.size ? `（${selected.size}）` : ""}</Button>
        <Button size="sm" disabled={!days || cleanup.isPending} title={days ? "按当前角色与时间筛选清理" : "请先填写天数"} onClick={() => confirm(`清理当前筛选下的历史任务（${days ? `近 ${days} 天` : ""}）？不可恢复！`) && cleanup.mutate()}>清理筛选结果</Button>
      </div>
    </Card>
    {tasks.isLoading ? <Spinner /> : filtered.length ? <Card className="overflow-x-auto p-0"><table className="w-full text-sm"><thead><tr className="border-b border-line text-left text-xs text-faint">
      <th className="whitespace-nowrap px-3 py-2 font-medium"><input type="checkbox" aria-label="全选非合并任务" checked={filtered.filter(t => !t.merge_of).every(t => selected.has(t.id)) && filtered.some(t => !t.merge_of)} onChange={toggleAll} className="size-4 accent-[var(--brand)]" /></th>
      <th className="whitespace-nowrap px-3 py-2 font-medium">ID</th><th className="whitespace-nowrap px-3 py-2 font-medium">标题</th><th className="whitespace-nowrap px-3 py-2 font-medium">角色</th><th className="whitespace-nowrap px-3 py-2 font-medium">项目</th><th className="whitespace-nowrap px-3 py-2 font-medium">权限</th><th className="whitespace-nowrap px-3 py-2 font-medium">状态</th><th className="whitespace-nowrap px-3 py-2 font-medium">轮次</th><th className="whitespace-nowrap px-3 py-2 font-medium">创建</th><th className="whitespace-nowrap px-3 py-2 font-medium">结束</th><th className="whitespace-nowrap px-3 py-2 font-medium">操作</th>
    </tr></thead><tbody className="divide-y divide-line">{filtered.map(task => <tr key={task.id} className="history-row hover:bg-hover">
      <td className="px-3 py-2"><input type="checkbox" aria-label={`选择任务 ${task.title}`} checked={selected.has(task.id)} onChange={() => toggle(task.id)} className="size-4 accent-[var(--brand)]" /></td>
      <td className="whitespace-nowrap px-3 py-2 text-faint">#{task.id}</td>
      <td className="whitespace-nowrap px-3 py-2 font-medium"><Link to={`/tasks/${task.id}`} className="hover:text-brand-soft">{task.title}</Link>{task.merge_of ? <span className="chip merge ml-1">合并 #{task.merge_of}</span> : null}</td>
      <td className="whitespace-nowrap px-3 py-2 text-muted">{task.role_name || "-"}</td>
      <td className="whitespace-nowrap px-3 py-2 text-muted">{task.project_name || "-"}</td>
      <td className="whitespace-nowrap px-3 py-2 text-muted">{PERM_LABEL[task.perm] || task.perm}</td>
      <td className="px-3 py-2"><TaskStatus status={task.status} /></td>
      <td className="whitespace-nowrap px-3 py-2 text-faint">{task.review_rounds || ""}</td>
      <td className="whitespace-nowrap px-3 py-2 text-faint">{formatTime(task.created_at)}</td>
      <td className="whitespace-nowrap px-3 py-2 text-faint">{formatTime(task.finished_at)}</td>
      <td className="px-3 py-2"><span className="ops inline-flex gap-1.5">
        {canRetryTask(task, all) ? <Button size="sm" variant="ghost" title={retryTaskLabel(task)} onClick={() => retry.mutate(task)}><RotateCcw size={13} /><span className="hidden sm:inline">{retryTaskLabel(task)}</span></Button> : null}
        {canDeleteTask(task) ? <Button size="sm" variant="danger" title="删除任务" onClick={() => confirm(`删除任务 #${task.id}？执行日志、worktree、任务分支及其合并子任务将一并删除。`) && remove.mutate(task)}><Trash2 size={13} /><span className="hidden sm:inline">删除</span></Button> : null}
      </span></td>
    </tr>)}</tbody></table></Card> : <Empty title="没有符合条件的记录" copy="调整筛选条件，或等任务进入终态。" />}
  </>;
}

/* ============================================================
   任务详情
   ============================================================ */
