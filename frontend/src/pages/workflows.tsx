import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CirclePlus, Clock, Code2, ListTree, Play, Snowflake, Trash2 } from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PageHeader } from "../components/shell";
import { TaskGraph } from "../components/visualization";
import { Badge, Button, Card, cn, Dialog, Empty, Field, inputClass, Spinner } from "../components/ui";
import { api, keys } from "../lib/api";
import type { Project, Role, Task, WorkflowRun, WorkflowSpec } from "../types";

/** Task.spec / Task.violations 是 JSON 字符串；parse 失败返回 null（列表/详情用占位展示，不崩溃）。 */
function parseWorkflowSpec(spec?: string | null): WorkflowSpec | null {
  if (!spec) return null;
  try {
    const parsed = JSON.parse(spec) as WorkflowSpec;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

interface WorkflowViolation { code: string; node_id?: string; message: string }

function parseViolations(violations?: string | null): WorkflowViolation[] {
  if (!violations) return [];
  try {
    const parsed = JSON.parse(violations);
    return Array.isArray(parsed) ? parsed as WorkflowViolation[] : [];
  } catch {
    return [];
  }
}

// 定时快捷选择：与 management.tsx SchedulesPage 的 parseScheduleCron/cronFromFields/scheduleLabel 同一套 cron 规则（内联实现，避免跨页 import）。
const SCHEDULE_WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const SCHEDULE_TIME = "09:00";

function cronFromFields(frequency: string, weekday: string, monthday: string, time: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return "";
  const minute = Number(match[2]);
  const hour = Number(match[1]);
  let dom = "*", dow = "*";
  if (frequency === "weekdays") dow = "1-5";
  if (frequency === "weekly") {
    const day = Number(weekday) || 1;
    dow = day === 7 ? "0" : String(day);
  }
  if (frequency === "monthly") dom = String(Number(monthday) || 1);
  return `0 ${minute} ${hour} ${dom} * ${dow}`;
}

function scheduleLabel(cron: string): string {
  const raw = String(cron || "").trim().toLowerCase();
  let frequency = "", weekday = "", monthday = "", time = "";
  if (raw === "@daily") { frequency = "daily"; time = "00:00"; }
  else if (raw === "@weekly") { frequency = "weekly"; weekday = "7"; time = "00:00"; }
  else if (raw === "@monthly") { frequency = "monthly"; monthday = "1"; time = "00:00"; }
  else {
    const fields = raw.split(/\s+/);
    if (fields.length === 5 || fields.length === 6) {
      const [second, minute, hour, dom, month, dow] = fields.length === 6 ? fields : ["0", fields[0], fields[1], fields[2], fields[3], fields[4]];
      if (second === "0" && month === "*" && /^\d{1,2}$/.test(minute) && /^\d{1,2}$/.test(hour)) {
        const minuteNum = Number(minute), hourNum = Number(hour);
        if (minuteNum <= 59 && hourNum <= 23) {
          time = `${String(hourNum).padStart(2, "0")}:${String(minuteNum).padStart(2, "0")}`;
          if (dom === "*" && dow === "*") frequency = "daily";
          else if (dom === "*" && dow === "1-5") frequency = "weekdays";
          else if (dom === "*" && /^\d$/.test(dow) && Number(dow) <= 7) { frequency = "weekly"; weekday = String(Number(dow) === 0 ? 7 : Number(dow)); }
          else if (dow === "*" && /^\d{1,2}$/.test(dom) && Number(dom) >= 1 && Number(dom) <= 31) { frequency = "monthly"; monthday = String(Number(dom)); }
        }
      }
    }
  }
  if (!frequency) return "自定义周期";
  if (frequency === "daily") return `每天 ${time}`;
  if (frequency === "weekdays") return `工作日 ${time}`;
  if (frequency === "weekly") return `每周${SCHEDULE_WEEKDAYS[Number(weekday) - 1] || ""} ${time}`;
  if (frequency === "monthly") return `每月${monthday}日 ${time}`;
  return "自定义周期";
}

export function WorkflowsPage() {
  const proposals = useQuery({ queryKey: ["workflow-proposals"], queryFn: () => api<Task[]>("/workflow-proposals") });
  const projects = useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/projects") });
  const roles = useQuery({ queryKey: keys.roles, queryFn: () => api<Role[]>("/roles") });
  const [open, setOpen] = useState(false);
  const plans = (proposals.data || []).filter(item => item.status === "adopted");
  return <>
    <PageHeader title="工作流" copy="Proposal 先经过确定性策略校验，采纳后冻结为不可变 Plan，再原子创建 Run 与任务依赖图。" actions={<Button variant="primary" onClick={() => setOpen(true)}><CirclePlus size={16} />新建 Proposal</Button>} />
    <div className="grid gap-4 xl:grid-cols-2"><section><h2 className="mb-3 text-sm font-semibold text-muted">待决 Proposal</h2>{proposals.isLoading ? <Spinner /> : proposals.data?.length ? <div className="grid gap-3">{proposals.data.map(item => {
      const spec = parseWorkflowSpec(item.spec);
      return <Link key={item.id} to={`/workflow-proposals/${item.id}`} className="rounded-xl border border-line bg-surface p-3.5 shadow-card transition hover:border-brand/35"><div className="flex items-center gap-2"><span className="text-xs text-faint">#{item.id}</span><h3 className="truncate font-semibold">{spec?.goal || "（无法解析规格）"}</h3><Badge tone={item.status === "validated" ? "good" : item.status === "rejected" ? "bad" : "neutral"}>{item.status}</Badge></div><p className="mt-2 text-sm text-muted">{spec ? `${spec.nodes.length} 个节点 · ` : ""}revision {item.revision}</p></Link>;
    })}</div> : <Empty title="没有 Proposal" copy="提交一份只描述意图、依赖和边界的工作流规格。" />}</section>
      <section><h2 className="mb-3 text-sm font-semibold text-muted">冻结 Plan</h2>{proposals.isLoading ? <Spinner /> : plans.length ? <div className="grid gap-3">{plans.map(item => {
        const spec = parseWorkflowSpec(item.spec);
        return <Link key={item.id} to={`/workflows/${item.id}`} className="rounded-xl border border-line bg-surface p-3.5 shadow-card transition hover:border-brand/35"><div className="flex items-center gap-2"><Snowflake size={15} className="text-brand-soft"/><h3 className="truncate font-semibold">{spec?.goal || "（无法解析规格）"}</h3><Badge tone="info">{item.status}</Badge></div><p className="mt-2 truncate font-mono text-xs text-muted">{item.spec_hash}</p></Link>;
      })}</div> : <Empty title="没有冻结 Plan" copy="通过校验并采纳 Proposal 后，Plan 会出现在这里。" />}</section></div>
    <NewProposalDialog open={open} onOpenChange={setOpen} projects={projects.data} roles={roles.data} />
  </>;
}

export function WorkflowProposalPage() {
  const id = Number(useParams().id);
  const item = useQuery({ queryKey: ["workflow-proposals", id], queryFn: () => api<Task>(`/workflow-proposals/${id}`) });
  const qc = useQueryClient();
  const act = useMutation({ mutationFn: (name: "validate" | "adopt") => api(`/workflow-proposals/${id}/${name}`, { method: "POST", revision: item.data?.revision }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["workflow-proposals"] }); qc.invalidateQueries({ queryKey: keys.workflows }); } });
  if (item.isLoading) return <Spinner />;
  if (!item.data) return <Empty title="Proposal 不存在" copy="请返回工作流列表。" />;
  const proposal = item.data;
  const spec = parseWorkflowSpec(proposal.spec);
  const violations = parseViolations(proposal.violations);
  return <><PageHeader title={spec?.goal || "（无法解析规格）"} copy={`由 ${spec?.created_by || "operator"} 创建 · revision ${proposal.revision}`} actions={<>{proposal.status !== "adopted" && <Button onClick={() => act.mutate("validate")}><CheckCircle2 size={16} />校验</Button>}{proposal.status === "validated" && <Button variant="primary" onClick={() => act.mutate("adopt")}><Snowflake size={16} />采纳并冻结</Button>}</>} />
    {violations.length > 0 && <Card className="mb-4 border-danger/30"><h2 className="font-semibold text-danger">策略拒绝</h2><ul className="mt-3 grid gap-2 text-sm text-muted">{violations.map((v, i) => <li key={i}><code className="text-danger">{v.code}</code>{v.node_id && ` · ${v.node_id}`}：{v.message}</li>)}</ul></Card>}{spec ? <WorkflowGraph spec={spec} /> : <Empty title="无法解析规格" copy="该 Proposal 的 spec 不是有效 JSON 字符串。" />}</>;
}

export function WorkflowPlanPage() {
  const id = Number(useParams().id);
  const plan = useQuery({ queryKey: ["workflows", id], queryFn: () => api<Task>(`/workflows/${id}`) });
  const runs = useQuery({ queryKey: ["workflows", id, "runs"], queryFn: () => api<WorkflowRun[]>(`/workflows/${id}/runs`), refetchInterval: query => (query.state.data as WorkflowRun[] | undefined)?.some(r => r.status === "running" || r.status === "created") ? 3000 : false });
  const qc = useQueryClient();
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const start = useMutation({ mutationFn: () => api<WorkflowRun>(`/workflows/${id}/runs`, { method: "POST", revision: plan.data?.revision }), onSuccess: value => { setRun(value); qc.invalidateQueries({ queryKey: ["workflows", id, "runs"] }); } });
  if (plan.isLoading) return <Spinner />;
  if (!plan.data) return <Empty title="Plan 不存在" copy="请返回工作流列表。" />;
  const spec = parseWorkflowSpec(plan.data.spec);
  const latest = run ?? runs.data?.[0] ?? null;
  const latestRunning = latest?.status === "running" || latest?.status === "created";
  const runTone: Record<string, "neutral" | "good" | "bad" | "info"> = { created: "neutral", running: "info", succeeded: "good", failed: "bad", cancelled: "neutral" };
  return <><PageHeader title={spec?.goal || "（无法解析规格）"} copy={`版本 ${spec?.version ?? 1} · ${plan.data.spec_hash}`} actions={<Button variant="primary" onClick={() => start.mutate()} disabled={start.isPending || latestRunning}><Play size={16} />{latestRunning ? "Run 进行中" : "启动 Run"}</Button>} />
    {latest && <Card className="mb-4"><div className="flex items-center gap-2"><Badge tone={runTone[latest.status] || "neutral"}>Run #{latest.id} · {latest.status}</Badge><span className="text-sm text-muted">{formatRunTime(latest.created_at)}{latest.finished_at ? ` · 结束 ${formatRunTime(latest.finished_at)}` : ""}</span></div>
      <table className="mt-3 w-full text-sm"><thead><tr className="border-b border-line text-left text-xs text-faint"><th className="py-1.5 pr-3 font-medium">节点</th><th className="py-1.5 pr-3 font-medium">意图</th><th className="py-1.5 font-medium">任务</th></tr></thead><tbody className="divide-y divide-line">{Object.entries(latest.task_ids).map(([nodeID, taskID]) => <tr key={nodeID}><td className="py-1.5 pr-3 font-mono text-xs text-muted">{nodeID}</td><td className="py-1.5 pr-3 text-muted">{spec?.nodes.find(n => n.id === nodeID)?.intent || "-"}</td><td className="py-1.5"><Link to={`/tasks/${taskID}`} className="text-brand-soft hover:underline">任务 #{taskID} →</Link></td></tr>)}</tbody></table></Card>}
    {run && <Card className="mb-4 border-success/30"><div className="flex items-center gap-2"><Badge tone="good">Run #{run.id}</Badge><span className="text-sm text-muted">已原子创建 {Object.keys(run.task_ids).length} 个任务</span></div></Card>}{spec ? <WorkflowGraph spec={spec} /> : <Empty title="无法解析规格" copy="该 Plan 的 spec 不是有效 JSON 字符串。" />}</>;
}

function formatRunTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function WorkflowGraph({ spec }: { spec: WorkflowSpec }) {
  const nodes = spec.nodes.map(node => ({ id: node.id, label: node.intent, status: node.approval_required ? "需审批" : node.permission }));
  const edges = spec.nodes.flatMap(node => (node.depends_on || []).map(parent => ({ from: parent, to: node.id })));
  return <TaskGraph title="任务依赖图" nodes={nodes} edges={edges} />;
}

/* ============================================================
   新建 Proposal：表单驱动，附带 JSON 高级模式。
   客户端校验镜像服务端 DefaultPolicy，避免提交被策略拒绝后才返工。
   ============================================================ */

const LIMITS = { budget: 1_000_000, max_nodes: 64, max_depth: 12, max_concurrency: 8, timeout: 24 * 60 * 60 };
const nodeIDPattern = /^[a-z][a-z0-9_-]{0,63}$/;

interface NodeDraft {
  key: number;
  id: string;
  intent: string;
  role_id: string;
  permission: "full" | "review";
  approval_required: boolean;
  depends_on: string[];
  timeout_seconds: string;
  failure_policy: "stop" | "continue";
  budget: string;
}

interface Draft {
  goal: string;
  project_id: string;
  budget: string;
  max_nodes: string;
  max_depth: string;
  max_concurrency: string;
  nodes: NodeDraft[];
}

let nodeSeq = 0;

function draftFromSpec(spec: WorkflowSpec): Draft {
  const limits = spec.limits || { budget: 0, max_nodes: 8, max_depth: 4, max_concurrency: 2 };
  return {
    goal: spec.goal || "",
    project_id: spec.project_id > 0 ? String(spec.project_id) : "",
    budget: String(limits.budget),
    max_nodes: String(limits.max_nodes),
    max_depth: String(limits.max_depth),
    max_concurrency: String(limits.max_concurrency),
    nodes: (spec.nodes || []).map(node => ({
      key: ++nodeSeq,
      id: node.id || "",
      intent: node.intent || "",
      role_id: node.role && node.role.role_id > 0 ? String(node.role.role_id) : "",
      permission: node.permission === "review" ? "review" : "full",
      approval_required: Boolean(node.approval_required),
      depends_on: [...(node.depends_on || [])],
      timeout_seconds: String(node.timeout_seconds || 3600),
      failure_policy: node.failure_policy === "continue" ? "continue" : "stop",
      budget: String(node.budget ?? 0),
    })),
  };
}

function buildSpec(draft: Draft): WorkflowSpec {
  return {
    version: 1,
    goal: draft.goal.trim(),
    project_id: Number(draft.project_id),
    created_by: "operator",
    adoption_policy: "manual",
    limits: { budget: Number(draft.budget), max_nodes: Number(draft.max_nodes), max_depth: Number(draft.max_depth), max_concurrency: Number(draft.max_concurrency) },
    nodes: draft.nodes.map(node => ({
      id: node.id,
      intent: node.intent.trim(),
      role: { role_id: Number(node.role_id) },
      permission: node.permission,
      approval_required: node.approval_required,
      ...(node.depends_on.length ? { depends_on: [...node.depends_on] } : {}),
      timeout_seconds: Number(node.timeout_seconds),
      failure_policy: node.failure_policy,
      budget: Number(node.budget),
    })),
  };
}

function analyzeGraph(nodes: NodeDraft[]): { cycle: boolean; depth: number } {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  let cycle = false;
  const depth = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) { cycle = true; return 0; }
    visiting.add(id);
    let d = 1;
    const node = byId.get(id);
    if (node) for (const dep of node.depends_on) d = Math.max(d, depth(dep) + 1);
    visiting.delete(id);
    memo.set(id, d);
    return d;
  };
  let maxDepth = 0;
  for (const node of nodes) maxDepth = Math.max(maxDepth, depth(node.id));
  return { cycle, depth: maxDepth };
}

function validateDraft(draft: Draft): string[] {
  const errors: string[] = [];
  const toNum = (value: string) => (value.trim() === "" ? Number.NaN : Number(value));
  if (!draft.goal.trim()) errors.push("目标不能为空");
  if (!draft.project_id) errors.push("请选择项目");
  const budget = toNum(draft.budget);
  if (!Number.isFinite(budget) || budget < 0 || budget > LIMITS.budget) errors.push(`总预算必须是 0–${LIMITS.budget} 的整数`);
  const maxNodes = toNum(draft.max_nodes);
  if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > LIMITS.max_nodes) errors.push(`最大节点数必须是 1–${LIMITS.max_nodes} 的整数`);
  const maxDepth = toNum(draft.max_depth);
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > LIMITS.max_depth) errors.push(`最大深度必须是 1–${LIMITS.max_depth} 的整数`);
  const maxConcurrency = toNum(draft.max_concurrency);
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > LIMITS.max_concurrency) errors.push(`最大并发必须是 1–${LIMITS.max_concurrency} 的整数`);

  const ids = new Map<string, number>();
  draft.nodes.forEach((node, index) => {
    const label = `节点 ${index + 1}`;
    if (!nodeIDPattern.test(node.id)) errors.push(`${label}：ID「${node.id || "（空）"}」必须是小写字母开头的 slug（a-z / 0-9 / - / _，最长 64）`);
    if (ids.has(node.id)) errors.push(`${label}：ID「${node.id}」重复`);
    ids.set(node.id, index);
    if (!node.intent.trim()) errors.push(`${label}：意图不能为空`);
    if (!node.role_id) errors.push(`${label}：请选择角色`);
    if (node.permission !== "full" && node.permission !== "review") errors.push(`${label}：权限必须是 full 或 review`);
    const timeout = toNum(node.timeout_seconds);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > LIMITS.timeout) errors.push(`${label}：超时必须是 1–${LIMITS.timeout} 秒的整数`);
    if (node.failure_policy !== "stop" && node.failure_policy !== "continue") errors.push(`${label}：失败策略必须是 stop 或 continue`);
    const nodeBudget = toNum(node.budget);
    if (!Number.isFinite(nodeBudget) || nodeBudget < 0) errors.push(`${label}：预算不能为负数`);
  });
  if (!draft.nodes.length) errors.push("至少需要一个节点");
  if (draft.nodes.length > (Number.isInteger(maxNodes) ? maxNodes : LIMITS.max_nodes)) errors.push(`节点数量 ${draft.nodes.length} 超过最大节点数上限`);

  let totalBudget = 0;
  draft.nodes.forEach((node, index) => {
    const label = `节点 ${index + 1}`;
    const nodeBudget = toNum(node.budget);
    if (Number.isFinite(nodeBudget)) totalBudget += nodeBudget;
    const seen = new Set<string>();
    for (const dep of node.depends_on) {
      if (dep === node.id) errors.push(`${label}：不能依赖自己`);
      else if (!ids.has(dep)) errors.push(`${label}：依赖的节点「${dep}」不存在`);
      else if (seen.has(dep)) errors.push(`${label}：依赖「${dep}」重复`);
      seen.add(dep);
    }
  });
  if (Number.isFinite(budget) && totalBudget > budget) errors.push(`节点预算总和 ${totalBudget} 超过总预算 ${budget}`);

  if (!errors.length) {
    const { cycle, depth } = analyzeGraph(draft.nodes);
    if (cycle) errors.push("依赖图存在循环");
    else if (depth > (Number.isInteger(maxDepth) ? maxDepth : LIMITS.max_depth)) errors.push(`依赖图深度 ${depth} 超过最大深度 ${maxDepth}`);
  }
  return errors;
}

export function NewProposalDialog({ open, onOpenChange, projects, roles }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  projects?: Project[];
  roles?: Role[];
}) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<"form" | "json">("form");
  const [draft, setDraft] = useState<Draft>(() => draftFromSpec(exampleSpec(0, 0)));
  const [json, setJson] = useState("");
  const [jsonError, setJsonError] = useState("");
  const [scheduled, setScheduled] = useState(false);
  const [frequency, setFrequency] = useState("daily");
  const [weekday, setWeekday] = useState("1");
  const [monthday, setMonthday] = useState("1");
  const [time, setTime] = useState(SCHEDULE_TIME);
  const [enabled, setEnabled] = useState(true);
  const didInit = useRef(false);
  const errors = useMemo(() => validateDraft(draft), [draft]);
  const create = useMutation({
    mutationFn: () => {
      const spec = mode === "json" ? (JSON.parse(json) as WorkflowSpec) : buildSpec(draft);
      const cron = scheduled ? cronFromFields(frequency, weekday, monthday, time) : "";
      if (scheduled && !cron) throw new Error("请选择有效的执行时间");
      const body: Record<string, unknown> = { spec };
      if (cron) { body.cron = cron; body.enabled = enabled; }
      return api<Task>("/workflow-proposals", { method: "POST", body });
    },
    onSuccess: () => { onOpenChange(false); qc.invalidateQueries({ queryKey: ["workflow-proposals"] }); },
  });
  useEffect(() => {
    if (open && !didInit.current) {
      didInit.current = true;
      const spec = exampleSpec(projects?.[0]?.id || 0, roles?.[0]?.id || 0);
      setDraft(draftFromSpec(spec));
      setJson(JSON.stringify(spec, null, 2));
      setMode("form");
      setJsonError("");
      setScheduled(false);
      setFrequency("daily");
      setWeekday("1");
      setMonthday("1");
      setTime(SCHEDULE_TIME);
      setEnabled(true);
    } else if (!open) {
      didInit.current = false;
    }
  }, [open, projects, roles]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (mode === "json") {
      try { JSON.parse(json); } catch (error) { setJsonError(`JSON 格式错误：${error instanceof Error ? error.message : String(error)}`); return; }
    } else if (errors.length) return;
    create.mutate();
  };
  const switchForm = () => {
    if (mode === "json") {
      try {
        setDraft(draftFromSpec(JSON.parse(json) as WorkflowSpec));
        setJsonError("");
        setMode("form");
      } catch (error) {
        setJsonError(`JSON 格式错误，无法切回表单：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  const switchJson = () => {
    if (mode === "form") setJson(JSON.stringify(buildSpec(draft), null, 2));
    setMode("json");
  };
  const addNode = () => setDraft(current => ({ ...current, nodes: [...current.nodes, { key: ++nodeSeq, id: "", intent: "", role_id: "", permission: "full" as const, approval_required: false, depends_on: [], timeout_seconds: "3600", failure_policy: "stop" as const, budget: "30" }] }));
  const removeNode = (key: number) => setDraft(current => ({ ...current, nodes: current.nodes.filter(node => node.key !== key) }));
  const updateNode = (key: number, patch: Partial<NodeDraft>) => setDraft(current => {
    const old = current.nodes.find(node => node.key === key);
    const nodes = current.nodes.map(node => (node.key === key ? { ...node, ...patch } : node));
    if (old && patch.id !== undefined && patch.id !== old.id) {
      for (const node of nodes) {
        if (node.key !== key && node.depends_on.includes(old.id)) node.depends_on = node.depends_on.map(dep => (dep === old.id ? patch.id as string : dep));
      }
    }
    return { ...current, nodes };
  });
  const otherIds = useMemo(() => {
    const seen = new Set<string>();
    const dup = new Set<string>();
    for (const node of draft.nodes) {
      if (!nodeIDPattern.test(node.id)) continue;
      if (seen.has(node.id)) dup.add(node.id);
      seen.add(node.id);
    }
    return [...seen].filter(id => !dup.has(id));
  }, [draft.nodes]);

  return <Dialog open={open} onOpenChange={onOpenChange} title="新建 Workflow Proposal" description="声明式描述工作流：目标、依赖与边界；节点不含可执行命令，提交后先经确定性策略校验。" wide>
    <form className="grid gap-4" onSubmit={submit}>
      <div className="flex w-fit items-center gap-1 rounded-lg border border-line bg-elevated p-1 text-sm">
        <button type="button" onClick={switchForm} className={cn("flex items-center gap-1.5 rounded-md px-3 py-1.5 transition", mode === "form" ? "bg-surface font-medium text-ink shadow-sm" : "text-muted hover:text-ink")}><ListTree size={14} />表单</button>
        <button type="button" onClick={switchJson} className={cn("flex items-center gap-1.5 rounded-md px-3 py-1.5 transition", mode === "json" ? "bg-surface font-medium text-ink shadow-sm" : "text-muted hover:text-ink")}><Code2 size={14} />JSON</button>
      </div>
      {mode === "form" ? <>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="目标" hint="一句话说明这个工作流要交付什么。"><input className={inputClass} value={draft.goal} onChange={event => setDraft({ ...draft, goal: event.target.value })} placeholder="例如：交付一个经过验证的变更" autoFocus /></Field>
          <Field label="项目"><select className={inputClass} value={draft.project_id} onChange={event => setDraft({ ...draft, project_id: event.target.value })}><option value="">选择项目</option>{projects?.filter(project => project.status === "active").map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="总预算" hint={`节点预算之和不能超过它（上限 ${LIMITS.budget}）`}><input type="number" min={0} max={LIMITS.budget} className={inputClass} value={draft.budget} onChange={event => setDraft({ ...draft, budget: event.target.value })} /></Field>
          <Field label="最大节点数" hint={`1–${LIMITS.max_nodes}`}><input type="number" min={1} max={LIMITS.max_nodes} className={inputClass} value={draft.max_nodes} onChange={event => setDraft({ ...draft, max_nodes: event.target.value })} /></Field>
          <Field label="最大深度" hint={`依赖链最长 ${LIMITS.max_depth} 层`}><input type="number" min={1} max={LIMITS.max_depth} className={inputClass} value={draft.max_depth} onChange={event => setDraft({ ...draft, max_depth: event.target.value })} /></Field>
          <Field label="最大并发" hint={`1–${LIMITS.max_concurrency}`}><input type="number" min={1} max={LIMITS.max_concurrency} className={inputClass} value={draft.max_concurrency} onChange={event => setDraft({ ...draft, max_concurrency: event.target.value })} /></Field>
        </div>
        <div>
          <div className="mb-2.5 flex items-baseline gap-2"><h3 className="text-sm font-semibold">节点</h3><span className="text-xs text-faint">{draft.nodes.length} 个 · 依赖决定执行顺序</span></div>
          <div className="grid gap-3">{draft.nodes.map((node, index) => <NodeEditor key={node.key} node={node} index={index} roles={roles} otherIds={otherIds.filter(id => id !== node.id)} onChange={patch => updateNode(node.key, patch)} onRemove={() => removeNode(node.key)} />)}</div>
          <button type="button" onClick={addNode} className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-line bg-surface/60 py-2.5 text-sm text-muted transition hover:border-brand/40 hover:text-ink"><CirclePlus size={15} />添加节点</button>
        </div>
        {errors.length > 0 && <div className="rounded-xl border border-danger/30 bg-danger/5 p-3"><h3 className="text-sm font-semibold text-danger">还有 {errors.length} 处需要修正</h3><ul className="mt-2 grid gap-1 text-sm leading-6 text-muted">{errors.map((error, i) => <li key={i}>{error}</li>)}</ul></div>}
        {create.error instanceof Error && <p className="text-sm text-danger">{create.error.message}</p>}
      </> : <>
        <Field label="Workflow Spec（JSON）" hint="仅表达声明式节点，不会直接执行命令。"><textarea className={inputClass + " min-h-[26rem] py-3 font-mono text-xs"} value={json} onChange={event => { setJson(event.target.value); setJsonError(""); }} /></Field>
        {jsonError && <p className="text-sm text-danger">{jsonError}</p>}
        {create.error instanceof Error && <p className="text-sm text-danger">{create.error.message}</p>}
      </>}
      <details className="rounded-xl border border-line bg-elevated p-3.5">
        <summary className="flex cursor-pointer select-none items-center gap-2 text-sm font-medium"><Clock size={15} className="text-muted" />定时执行{scheduled ? (cronFromFields(frequency, weekday, monthday, time) ? <span className="ml-auto text-xs font-normal text-muted">{scheduleLabel(cronFromFields(frequency, weekday, monthday, time))}</span> : <span className="ml-auto text-xs font-normal text-danger">时间无效</span>) : <span className="ml-auto text-xs font-normal text-faint">关闭 · cron 为空 = 普通工作流</span>}</summary>
        <div className="mt-3 grid gap-3">
          <label className="flex min-h-11 items-center gap-3 rounded-xl border border-line bg-surface px-3 text-sm"><input type="checkbox" className="accent-brand" checked={scheduled} onChange={event => setScheduled(event.target.checked)} />按 cron 定时执行（不勾选 = 普通工作流，立即进入校验）</label>
          {scheduled && <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="频率"><select className={inputClass} value={frequency} onChange={event => setFrequency(event.target.value)}><option value="daily">每天</option><option value="weekdays">工作日</option><option value="weekly">每周</option><option value="monthly">每月</option></select></Field>
              <Field label="时间"><input type="time" className={inputClass} value={time} onChange={event => setTime(event.target.value)} /></Field>
              {frequency === "weekly" && <Field label="星期"><select className={inputClass} value={weekday} onChange={event => setWeekday(event.target.value)}>{SCHEDULE_WEEKDAYS.map((label, i) => <option key={i + 1} value={i + 1}>{label}</option>)}</select></Field>}
              {frequency === "monthly" && <Field label="日期"><select className={inputClass} value={monthday} onChange={event => setMonthday(event.target.value)}>{Array.from({ length: 28 }, (_, i) => i + 1).map(day => <option key={day} value={day}>{day}日</option>)}</select></Field>}
            </div>
            <label className="flex min-h-11 items-center gap-3 rounded-xl border border-line bg-surface px-3 text-sm"><input type="checkbox" className="accent-brand" checked={enabled} onChange={event => setEnabled(event.target.checked)} />启用该定时（取消勾选 = 暂停，不产生执行）</label>
            {!cronFromFields(frequency, weekday, monthday, time) && <p className="text-sm text-danger">请选择有效的执行时间</p>}
          </>}
        </div>
      </details>
      <div className="flex items-center gap-2"><span className="mr-auto text-xs leading-5 text-faint">提交后进入策略校验，通过后可在「审批」页采纳冻结为不可变 Plan。</span><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" variant="primary" disabled={create.isPending || (mode === "form" && errors.length > 0)}>提交 Proposal</Button></div>
    </form>
  </Dialog>;
}

function NodeEditor({ node, index, roles, otherIds, onChange, onRemove }: {
  node: NodeDraft;
  index: number;
  roles?: Role[];
  otherIds: string[];
  onChange(patch: Partial<NodeDraft>): void;
  onRemove(): void;
}) {
  return <div className="rounded-xl border border-line bg-elevated p-3.5">
    <div className="mb-3 flex flex-wrap items-center gap-2"><span className="text-sm font-semibold">节点 {index + 1}</span>{node.id ? <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-xs text-muted">{node.id}</code> : null}<span className="ml-auto" /><Button size="sm" variant="ghost" onClick={onRemove}><Trash2 size={14} />删除</Button></div>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <Field label="节点 ID" hint="小写字母开头的 slug，供依赖引用"><input className={inputClass + " font-mono"} value={node.id} onChange={event => onChange({ id: event.target.value })} placeholder="implement" /></Field>
      <Field label="角色"><select className={inputClass} value={node.role_id} onChange={event => onChange({ role_id: event.target.value })}><option value="">选择角色</option>{roles?.filter(role => role.enabled).map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select></Field>
      <Field label="权限"><select className={inputClass} value={node.permission} onChange={event => onChange({ permission: event.target.value as "full" | "review" })}><option value="full">full · 自动整合</option><option value="review">review · 人工审批</option></select></Field>
    </div>
    <div className="mt-3"><Field label="意图" hint="节点要完成什么；只写意图，不含可执行命令"><textarea className={inputClass + " min-h-20 py-3"} value={node.intent} onChange={event => onChange({ intent: event.target.value })} /></Field></div>
    <div className="mt-3 grid gap-3 sm:grid-cols-3">
      <Field label="超时（秒）"><input type="number" min={1} className={inputClass} value={node.timeout_seconds} onChange={event => onChange({ timeout_seconds: event.target.value })} /></Field>
      <Field label="失败策略"><select className={inputClass} value={node.failure_policy} onChange={event => onChange({ failure_policy: event.target.value as "stop" | "continue" })}><option value="stop">stop · 失败即停</option><option value="continue">continue · 继续后续</option></select></Field>
      <Field label="预算"><input type="number" min={0} className={inputClass} value={node.budget} onChange={event => onChange({ budget: event.target.value })} /></Field>
    </div>
    <div className="mt-3"><span className="text-sm font-medium">依赖节点</span>
      <div className="mt-1.5 flex flex-wrap gap-1.5">{otherIds.length ? otherIds.map(id => { const checked = node.depends_on.includes(id); return <label key={id} className={cn("flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition select-none", checked ? "border-brand/40 bg-brand/10 text-brand-soft" : "border-line bg-surface text-muted hover:border-muted/50")}><input type="checkbox" className="accent-brand" checked={checked} onChange={event => onChange({ depends_on: event.target.checked ? [...node.depends_on, id] : node.depends_on.filter(dep => dep !== id) })} /><code className="font-mono">{id}</code></label>; }) : <span className="text-xs text-faint">为其他节点填写有效 ID 后可建立依赖</span>}</div>
    </div>
    <label className="mt-3 flex min-h-11 items-center gap-3 rounded-xl border border-line bg-surface px-3 text-sm"><input type="checkbox" className="accent-brand" checked={node.approval_required} onChange={event => onChange({ approval_required: event.target.checked })} />需要人工审批</label>
  </div>;
}

function exampleSpec(projectID: number, roleID: number): WorkflowSpec {
  return { version: 1, goal: "交付一个经过验证的变更", project_id: projectID, created_by: "operator", adoption_policy: "manual", limits: { budget: 100, max_nodes: 8, max_depth: 4, max_concurrency: 2 }, nodes: [
    { id: "implement", intent: "实现目标并运行相关检查", role: { role_id: roleID, required_capabilities: ["batch"] }, permission: "full", approval_required: false, timeout_seconds: 3600, failure_policy: "stop", budget: 70 },
    { id: "review", intent: "独立复核实现与检查结果", role: { role_id: roleID, required_capabilities: ["batch"] }, depends_on: ["implement"], permission: "review", approval_required: true, input_refs: ["node:implement"], timeout_seconds: 1800, failure_policy: "stop", budget: 30 }
  ] };
}
