import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CirclePlus, RotateCcw, Snowflake, X } from "lucide-react";
import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PageHeader } from "../components/shell";
import { Button, Card, Dialog, Empty, Field, inputClass, Spinner, useToast } from "../components/ui";
import { api, keys } from "../lib/api";
import type { Task, WorkflowSpec } from "../types";

/** Task.spec 是 JSON 字符串；parse 失败返回 null（列表展示用占位，不崩溃）。 */
function parseProposalSpec(spec?: string | null): WorkflowSpec | null {
  if (!spec) return null;
  try {
    const parsed = JSON.parse(spec) as WorkflowSpec;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/* ============================================================
   审批工作台：主线上的一道闸口，聚合所有待审批点
   —— review 任务交付（批准/驳回/取消）与 Workflow Proposal 采纳
   ============================================================ */

function formatTime(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function ApprovalsPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tasks = useQuery({ queryKey: keys.tasks, queryFn: () => api<Task[]>("/tasks"), refetchInterval: 15_000 });
  const proposals = useQuery({ queryKey: ["workflow-proposals"], queryFn: () => api<Task[]>("/workflow-proposals"), refetchInterval: 15_000 });
  const [rejectTask, setRejectTask] = useState<Task | null>(null);
  const [rejectNote, setRejectNote] = useState("");

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: keys.tasks });
    queryClient.invalidateQueries({ queryKey: keys.stats });
    queryClient.invalidateQueries({ queryKey: ["workflow-proposals"] });
    queryClient.invalidateQueries({ queryKey: keys.workflows });
  };
  const patchTask = useMutation({
    mutationFn: ({ id, status, note }: { id: number; status: string; note?: string }) => {
      const body: Record<string, unknown> = { status };
      if (note !== undefined) body.review_note = note;
      return api(`/tasks/${id}`, { method: "PATCH", revision: tasks.data?.find(t => t.id === id)?.revision, body });
    },
    onSuccess: () => { invalidate(); toast("已更新"); },
    onError: error => toast((error as Error).message, "bad")
  });
  const adoptProposal = useMutation({
    mutationFn: (item: Task) => api(`/workflow-proposals/${item.id}/adopt`, { method: "POST", revision: item.revision }),
    onSuccess: () => { invalidate(); toast("已采纳并冻结为 Plan"); },
    onError: error => toast((error as Error).message, "bad")
  });

  const reviewTasks = (tasks.data || []).filter(t => t.status === "awaiting_review").sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const pendingProposals = (proposals.data || []).filter(p => p.status === "validated").sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));

  return <>
    <PageHeader title="审批" copy="主线上的一道闸口：任务交付与 Workflow 采纳集中在这里裁决；批准后进入代码整合或冻结执行。" />
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(18rem,.8fr)]">
      <section>
        <div className="mb-3 flex items-center"><h2 className="font-semibold">任务交付</h2><span className="ml-auto text-sm text-faint">{reviewTasks.length} 条等待裁决</span></div>
        {tasks.isLoading ? <Spinner /> : reviewTasks.length ? <div className="grid gap-2">
          {reviewTasks.map(task => <article key={task.id} className="rounded-xl border border-line bg-elevated p-3.5 transition hover:border-brand/35">
            <div className="flex flex-wrap items-center gap-2"><span className="text-xs text-faint">#{task.id}</span>
              <Link to={`/tasks/${task.id}`} className="truncate font-semibold text-ink hover:text-brand-soft" onClick={e => e.stopPropagation()}>{task.title}</Link>
              {task.project_name ? <span className="chip">{task.project_name}</span> : null}
              {task.role_name ? <span className="chip">{task.role_name}</span> : null}
              <span className="ml-auto text-xs text-faint">{formatTime(task.created_at)}</span></div>
            {task.body ? <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted">{task.body}</p> : null}
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Button size="sm" variant="primary" disabled={patchTask.isPending} onClick={() => patchTask.mutate({ id: task.id, status: "succeeded" })}><Check size={14} />通过并派发合并</Button>
              <Button size="sm" onClick={() => { setRejectNote(""); setRejectTask(task); }}><RotateCcw size={14} />驳回重做</Button>
              <Button size="sm" variant="danger" onClick={() => { if (confirm(`取消任务 #${task.id}？`)) patchTask.mutate({ id: task.id, status: "cancelled" }); }}><X size={14} />取消</Button>
              <Button size="sm" variant="ghost" onClick={() => navigate(`/tasks/${task.id}`)}>查看详情与改动</Button>
            </div>
          </article>)}
        </div> : <Card><Empty title="当前无需审批" copy="review 任务执行完毕后会出现在这里。" /></Card>}
      </section>
      <section>
        <div className="mb-3 flex items-center"><h2 className="font-semibold">Workflow 采纳</h2><span className="ml-auto text-sm text-faint">{pendingProposals.length} 条待冻结</span></div>
        {proposals.isLoading ? <Spinner /> : pendingProposals.length ? <div className="grid gap-2">
          {pendingProposals.map(item => {
            const spec = parseProposalSpec(item.spec);
            return <article key={item.id} className="rounded-xl border border-line bg-elevated p-3.5 transition hover:border-brand/35">
              <div className="flex items-center gap-2"><span className="text-xs text-faint">#{item.id}</span>
                <Link to={`/workflow-proposals/${item.id}`} className="truncate font-semibold text-ink hover:text-brand-soft">{spec?.goal || "（无法解析规格）"}</Link></div>
              <p className="mt-2 text-xs text-muted">{spec ? `${spec.nodes.length} 个节点 · 预算 ${spec.limits?.budget ?? "-"} · revision ${item.revision}` : `revision ${item.revision}`}</p>
              <div className="mt-2.5 flex flex-wrap gap-2">
                <Button size="sm" variant="primary" disabled={adoptProposal.isPending} onClick={() => { if (confirm("采纳该 Proposal 并冻结为不可变 Plan？")) adoptProposal.mutate(item); }}><Snowflake size={14} />采纳并冻结</Button>
                <Button size="sm" variant="ghost" onClick={() => navigate(`/workflow-proposals/${item.id}`)}>查看规格</Button>
              </div>
            </article>;
          })}
        </div> : <Card><Empty title="没有待采纳的 Proposal" copy="校验通过的 Proposal 会出现在这里，采纳后冻结为不可变 Plan。" action={<Button size="sm" onClick={() => navigate("/workflows")}><CirclePlus size={14} />新建 Proposal</Button>} /></Card>}
      </section>
    </div>
    <Dialog open={rejectTask !== null} onOpenChange={open => !open && setRejectTask(null)} title="驳回重做" description="填写驳回原因 / 修改意见（将追加到任务提示词，重新执行）。">
      <form className="grid gap-4" onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (!rejectTask) return;
        patchTask.mutate({ id: rejectTask.id, status: "queued", note: rejectNote });
        setRejectTask(null);
        toast("已驳回，任务重新执行");
      }}>
        <Field label="驳回原因"><textarea className={inputClass + " min-h-28 py-3"} autoFocus required value={rejectNote} onChange={e => setRejectNote(e.target.value)} placeholder="例如：接口命名不符合规范，请改为…" /></Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setRejectTask(null)}>取消</Button><Button type="submit" variant="primary">驳回并重新执行</Button></div>
      </form>
    </Dialog>
  </>;
}
