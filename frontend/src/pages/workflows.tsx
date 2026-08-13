import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CirclePlus, Play, Snowflake } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PageHeader } from "../components/shell";
import { TaskGraph } from "../components/visualization";
import { Badge, Button, Card, Dialog, Empty, Field, inputClass, Spinner } from "../components/ui";
import { api, keys } from "../lib/api";
import type { Project, Role, WorkflowPlan, WorkflowProposal, WorkflowRun, WorkflowSpec } from "../types";

export function WorkflowsPage() {
  const proposals = useQuery({ queryKey: ["workflow-proposals"], queryFn: () => api<WorkflowProposal[]>("/workflow-proposals") });
  const plans = useQuery({ queryKey: keys.workflows, queryFn: () => api<WorkflowPlan[]>("/workflows") });
  const projects = useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/projects") });
  const roles = useQuery({ queryKey: keys.roles, queryFn: () => api<Role[]>("/roles") });
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const initial = useMemo(() => exampleSpec(projects.data?.[0]?.id || 0, roles.data?.[0]?.id || 0), [projects.data, roles.data]);
  const [source, setSource] = useState("");
  const create = useMutation({ mutationFn: () => api<WorkflowProposal>("/workflow-proposals", { method: "POST", body: JSON.parse(source || JSON.stringify(initial)) }), onSuccess: () => { setOpen(false); setSource(""); qc.invalidateQueries({ queryKey: ["workflow-proposals"] }); } });
  return <>
    <PageHeader kicker="Controlled orchestration" title="工作流" copy="Proposal 先经过确定性策略校验，采纳后冻结为不可变 Plan，再原子创建 Run 与任务依赖图。" actions={<Button variant="primary" onClick={() => { setSource(JSON.stringify(initial, null, 2)); setOpen(true); }}><CirclePlus size={16} />新建 Proposal</Button>} />
    <div className="grid gap-7 xl:grid-cols-2"><section><h2 className="mb-3 text-sm font-semibold text-muted">待决 Proposal</h2>{proposals.isLoading ? <Spinner /> : proposals.data?.length ? <div className="grid gap-3">{proposals.data.map(item => <Link key={item.id} to={`/workflow-proposals/${item.id}`} className="rounded-2xl border border-line bg-surface p-5 shadow-card transition hover:border-brand/35"><div className="flex items-center gap-2"><span className="text-xs text-faint">#{item.id}</span><h3 className="truncate font-semibold">{item.spec.goal}</h3><Badge tone={item.status === "validated" ? "good" : item.status === "rejected" ? "bad" : "neutral"}>{item.status}</Badge></div><p className="mt-3 text-sm text-muted">{item.spec.nodes.length} 个节点 · revision {item.revision}</p></Link>)}</div> : <Empty title="没有 Proposal" copy="提交一份只描述意图、依赖和边界的工作流规格。" />}</section>
      <section><h2 className="mb-3 text-sm font-semibold text-muted">冻结 Plan</h2>{plans.isLoading ? <Spinner /> : plans.data?.length ? <div className="grid gap-3">{plans.data.map(item => <Link key={item.id} to={`/workflows/${item.id}`} className="rounded-2xl border border-line bg-surface p-5 shadow-card transition hover:border-brand/35"><div className="flex items-center gap-2"><Snowflake size={15} className="text-brand-soft"/><h3 className="truncate font-semibold">{item.spec.goal}</h3><Badge tone="info">{item.status}</Badge></div><p className="mt-3 truncate font-mono text-xs text-muted">{item.spec_hash}</p></Link>)}</div> : <Empty title="没有冻结 Plan" copy="通过校验并采纳 Proposal 后，Plan 会出现在这里。" />}</section></div>
    <Dialog open={open} onOpenChange={setOpen} title="新建 Workflow Proposal" description="JSON 仅能表达声明式节点，不会直接执行命令。" wide><form className="grid gap-4" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}><Field label="Workflow Spec"><textarea className={inputClass + " min-h-[28rem] py-3 font-mono text-xs"} value={source} onChange={e => setSource(e.target.value)} /></Field>{create.error instanceof Error && <p className="text-sm text-danger">{create.error.message}</p>}<div className="flex justify-end"><Button variant="primary">提交 Proposal</Button></div></form></Dialog>
  </>;
}

export function WorkflowProposalPage() {
  const id = Number(useParams().id);
  const item = useQuery({ queryKey: ["workflow-proposals", id], queryFn: () => api<WorkflowProposal>(`/workflow-proposals/${id}`) });
  const qc = useQueryClient();
  const act = useMutation({ mutationFn: (name: "validate" | "adopt") => api(`/workflow-proposals/${id}/${name}`, { method: "POST", revision: item.data?.revision }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["workflow-proposals"] }); qc.invalidateQueries({ queryKey: keys.workflows }); } });
  if (item.isLoading) return <Spinner />;
  if (!item.data) return <Empty title="Proposal 不存在" copy="请返回工作流列表。" />;
  const proposal = item.data;
  return <><PageHeader kicker={`Proposal #${id}`} title={proposal.spec.goal} copy={`由 ${proposal.spec.created_by || "operator"} 创建 · revision ${proposal.revision}`} actions={<>{proposal.status !== "adopted" && <Button onClick={() => act.mutate("validate")}><CheckCircle2 size={16} />校验</Button>}{proposal.status === "validated" && <Button variant="primary" onClick={() => act.mutate("adopt")}><Snowflake size={16} />采纳并冻结</Button>}</>} />
    {proposal.violations.length > 0 && <Card className="mb-5 border-danger/30"><h2 className="font-semibold text-danger">策略拒绝</h2><ul className="mt-3 grid gap-2 text-sm text-muted">{proposal.violations.map((v, i) => <li key={i}><code className="text-danger">{v.code}</code>{v.node_id && ` · ${v.node_id}`}：{v.message}</li>)}</ul></Card>}<WorkflowGraph spec={proposal.spec} /></>;
}

export function WorkflowPlanPage() {
  const id = Number(useParams().id);
  const plan = useQuery({ queryKey: ["workflows", id], queryFn: () => api<WorkflowPlan>(`/workflows/${id}`) });
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const start = useMutation({ mutationFn: () => api<WorkflowRun>(`/workflows/${id}/runs`, { method: "POST", revision: plan.data?.revision }), onSuccess: setRun });
  if (plan.isLoading) return <Spinner />;
  if (!plan.data) return <Empty title="Plan 不存在" copy="请返回工作流列表。" />;
  return <><PageHeader kicker={`Frozen plan #${id}`} title={plan.data.spec.goal} copy={`版本 ${plan.data.version} · ${plan.data.spec_hash}`} actions={<Button variant="primary" onClick={() => start.mutate()} disabled={start.isPending || !!run}><Play size={16} />启动 Run</Button>} />{run && <Card className="mb-5 border-success/30"><div className="flex items-center gap-2"><Badge tone="good">Run #{run.id}</Badge><span className="text-sm text-muted">已原子创建 {Object.keys(run.task_ids).length} 个任务</span></div></Card>}<WorkflowGraph spec={plan.data.spec} /></>;
}

function WorkflowGraph({ spec }: { spec: WorkflowSpec }) {
  const nodes = spec.nodes.map(node => ({ id: node.id, label: node.intent, status: node.approval_required ? "需审批" : node.permission }));
  const edges = spec.nodes.flatMap(node => (node.depends_on || []).map(parent => ({ from: parent, to: node.id })));
  return <TaskGraph title="任务依赖图" nodes={nodes} edges={edges} />;
}

function exampleSpec(projectID: number, roleID: number): WorkflowSpec {
  return { version: 1, goal: "交付一个经过验证的变更", project_id: projectID, created_by: "operator", adoption_policy: "manual", limits: { budget: 100, max_nodes: 8, max_depth: 4, max_concurrency: 2 }, nodes: [
    { id: "implement", intent: "实现目标并运行相关检查", role: { role_id: roleID, required_capabilities: ["batch"] }, permission: "full", approval_required: false, timeout_seconds: 3600, failure_policy: "stop", budget: 70 },
    { id: "review", intent: "独立复核实现与检查结果", role: { role_id: roleID, required_capabilities: ["batch"] }, depends_on: ["implement"], permission: "review", approval_required: true, input_refs: ["node:implement"], timeout_seconds: 1800, failure_policy: "stop", budget: 30 }
  ] };
}
