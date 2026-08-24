import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical, MessagesSquare } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { MutationError } from "../project/mutation-error";
import { StatusBarHTML } from "../project/stats";
import { TaskStatus } from "../task/status";
import { Badge, Button, Dialog, Field, inputClass, Spinner, useToast } from "../ui";
import { api, keys } from "../../lib/api";
import type { Role, RoleConfig, RoleProjectStat, RoleStats, RoleStudioDraft, RoleStudioMessage, RoleStudioResult, RuntimeDescriptor, RuntimeField, Skill, StatusCount, Task } from "../../types";
import { DelegationFields, resolveRuntimeField, RoleSkillPicker, RuntimeFieldInput, statusLabelOf } from "./form";

export function RoleDetailDialog({ role, onClose }: { role: Role; onClose(): void }) {
  const stats = useQuery({ queryKey: ["stats", "roles", role.id], queryFn: () => api<RoleStats>(`/stats/roles/${role.id}`) });
  const recent = useQuery({ queryKey: ["tasks", "role", role.id], queryFn: () => api<Task[]>(`/tasks?role_id=${role.id}&limit=10`) });
  const stat = stats.data;
  const metrics: Array<[string, number | string]> = [
    ["总任务", stat?.total ?? 0], ["进行中", stat?.in_flight ?? 0], ["完成", stat?.succeeded ?? 0], ["失败", stat?.failed ?? 0], ["取消", stat?.cancelled ?? 0], ["待审批", stat?.reviews ?? 0], ["成功率", stat ? `${Math.round(stat.success_rate)}%` : 0]
  ];
  return <Dialog open onOpenChange={open => !open && onClose()} title={`角色详情 · ${role.name}`} wide>
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2"><Badge tone="info">{role.runtime_id}</Badge><Badge>并发 {role.max_concurrency}</Badge>{role.role_config.model && <Badge>{role.role_config.model}</Badge>}{role.delegation_enabled ? <Badge tone="good">编排者 · 子任务最多 {role.delegation_max_perm}</Badge> : null}<Badge tone={role.enabled ? "good" : "neutral"}>{role.enabled ? "启用" : "停用"}</Badge></div>
      {role.description && <p className="text-sm leading-6 text-muted">{role.description}</p>}
      {stats.isLoading ? <Spinner /> : stat ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{metrics.map(([label, num]) => <div key={label} className="rounded-xl border border-line bg-elevated p-3"><div className="text-xs text-muted">{label}</div><div className="mt-1 text-xl font-semibold">{num}</div></div>)}</div> : null}
      {stat?.status_counts?.length ? <div className="grid gap-1.5"><StatusBarHTML counts={stat.status_counts} />{stat.status_counts.map((item: StatusCount) => <div key={item.status} className="flex items-center gap-3 text-sm"><span className="w-20 shrink-0 text-muted">{statusLabelOf(item.status)}</span><div className="h-2 flex-1 overflow-hidden rounded-full bg-elevated"><div className="h-full rounded-full bg-brand/70" style={{ width: `${stat.total ? (item.count / stat.total) * 100 : 0}%` }} /></div><span className="w-8 text-right text-muted">{item.count}</span></div>)}</div> : null}
      {stat?.projects?.length ? <div><h3 className="mb-2 text-sm font-semibold text-muted">项目产出</h3><div className="overflow-x-auto"><table className="w-full min-w-[30rem] text-left text-sm"><thead><tr className="border-b border-line text-xs uppercase tracking-wide text-muted"><th className="py-2 pr-3 font-medium">项目</th><th className="py-2 pr-3 font-medium">总任务</th><th className="py-2 pr-3 font-medium">完成</th><th className="py-2 pr-3 font-medium">失败</th><th className="py-2 font-medium">成功率</th></tr></thead><tbody className="divide-y divide-line">{stat.projects.map((item: RoleProjectStat) => <tr key={item.project_id}><td className="py-2.5 pr-3">{item.project_name || `项目 #${item.project_id}`}</td><td className="py-2.5 pr-3">{item.total}</td><td className="py-2.5 pr-3">{item.succeeded}</td><td className="py-2.5 pr-3">{item.failed}</td><td className="py-3">{Math.round(item.success_rate)}%</td></tr>)}</tbody></table></div></div> : null}
      {recent.data?.length ? <div><h3 className="mb-2 text-sm font-semibold text-muted">最近任务</h3><div className="grid gap-2">{recent.data.map(task => <Link key={task.id} to={`/tasks/${task.id}`} className="flex items-center gap-2 rounded-xl border border-line bg-elevated px-3 py-2 text-sm hover:border-brand/40"><span className="min-w-0 flex-1 truncate">{task.title}</span><TaskStatus status={task.status} /></Link>)}</div></div> : null}
      <div className="flex justify-end"><Button variant="ghost" onClick={onClose}>关闭</Button></div>
    </div>
  </Dialog>;
}

export function RoleStudioDialog({ initial, onClose }: { initial: { role?: Role; draft: RoleStudioDraft }; onClose(): void }) {
  const runtimes = useQuery({ queryKey: keys.runtimes, queryFn: () => api<RuntimeDescriptor[]>("/runtimes") });
  const skills = useQuery({ queryKey: keys.skills, queryFn: () => api<Skill[]>("/skills") });
  const roles = useQuery({ queryKey: keys.roles, queryFn: () => api<Role[]>("/roles") });
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<RoleStudioDraft>(initial.draft);
  const [creatorID, setCreatorID] = useState(0);
  const [tab, setTab] = useState<"chat" | "test">("chat");
  const [chatMsg, setChatMsg] = useState("");
  const [testMsg, setTestMsg] = useState("");
  const [creatorMessages, setCreatorMessages] = useState<RoleStudioMessage[]>([]);
  const [testMessages, setTestMessages] = useState<RoleStudioMessage[]>([]);
  const [testOutput, setTestOutput] = useState("");
  const selected = runtimes.data?.find(runtime => runtime.id === draft.runtime_id);
  const setField = (field: RuntimeField, value: unknown) => setDraft(prev => ({ ...prev, role_config: field.builtin ? { ...prev.role_config, [field.key]: value } : { ...prev.role_config, custom: { ...prev.role_config.custom, [field.key]: String(value) } } }));
  const chat = useMutation({
    mutationFn: () => api<RoleStudioResult>("/role-studio/chat", { method: "POST", body: { creator_role_id: creatorID, draft, message: chatMsg, creator_messages: creatorMessages, test_messages: testMessages } }),
    onSuccess: result => {
      setCreatorMessages(prev => [...prev, { role: "user", content: chatMsg }, { role: "assistant", content: result.message }]);
      if (result.draft) { setDraft(result.draft); toast("已应用助手草稿"); }
      setChatMsg("");
    },
    onError: error => toast((error as Error).message, "bad")
  });
  const test = useMutation({
    mutationFn: () => api<{ output: string }>("/role-studio/test", { method: "POST", body: { draft, message: testMsg, test_messages: testMessages } }),
    onSuccess: result => { setTestMessages(prev => [...prev, { role: "user", content: testMsg }]); setTestOutput(result.output); setTestMsg(""); },
    onError: error => toast((error as Error).message, "bad")
  });
  const save = useMutation({
    mutationFn: () => initial.role
      ? api<Role>(`/roles/${initial.role.id}`, { method: "PATCH", revision: initial.role.revision, body: { name: draft.name, description: draft.description, runtime_id: draft.runtime_id, role_config: draft.role_config, max_concurrency: draft.max_concurrency, delegation_enabled: draft.delegation_enabled ?? false, delegation_max_perm: draft.delegation_max_perm === "full" ? "full" : "review", enabled: initial.role.enabled } })
      : api<Role>("/roles", { method: "POST", body: { name: draft.name, description: draft.description, runtime_id: draft.runtime_id, role_config: draft.role_config, max_concurrency: draft.max_concurrency, delegation_enabled: draft.delegation_enabled ?? false, delegation_max_perm: draft.delegation_max_perm === "full" ? "full" : "review", enabled: true } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: keys.roles }); toast("角色已保存"); onClose(); },
    onError: error => toast((error as Error).message, "bad")
  });
  const tabClass = (active: boolean) => `flex-1 rounded-lg px-3 py-2 text-sm font-medium ${active ? "bg-brand/15 text-brand-soft" : "text-muted hover:bg-hover"}`;
  return <Dialog open onOpenChange={open => !open && onClose()} title={`角色助手 · ${initial.role?.name || "新角色"}`} description="向创建助手描述职责，或测试草稿的实际表现；助手可改写草稿。">
    <div className="grid gap-4">
      <div className="grid gap-4 md:grid-cols-2"><Field label="名称"><input className={inputClass} required value={draft.name || ""} onChange={e => setDraft({ ...draft, name: e.target.value })} /></Field><Field label="Runtime"><select className={inputClass} value={draft.runtime_id} onChange={e => setDraft({ ...draft, runtime_id: e.target.value, role_config: {} })}>{runtimes.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field></div>
      <Field label="职责说明"><textarea className={inputClass + " min-h-20 py-3"} value={draft.description || ""} onChange={e => setDraft({ ...draft, description: e.target.value })} /></Field>
      <div className="grid gap-4 md:grid-cols-2">{selected?.fields.map(field => field.source === "skills" ? <RoleSkillPicker key={field.key} skills={skills.data} value={field.builtin ? draft.role_config[field.key as keyof RoleConfig] : draft.role_config.custom?.[field.key]} onChange={value => setField(field, value)} /> : <RuntimeFieldInput key={field.key} field={resolveRuntimeField(field, draft.role_config, skills.data)} value={field.builtin ? draft.role_config[field.key as keyof RoleConfig] : draft.role_config.custom?.[field.key]} onChange={value => setField(field, value)} />)}</div>
      <div className="grid gap-4 md:grid-cols-2"><Field label="最大并发"><input className={inputClass} type="number" min="1" value={draft.max_concurrency || 1} onChange={e => setDraft({ ...draft, max_concurrency: Number(e.target.value) })} /></Field><Field label="创建助手角色" hint="角色助手由哪个已启用角色驱动"><select className={inputClass} value={creatorID} onChange={e => setCreatorID(Number(e.target.value))}><option value={0}>自动选择</option>{roles.data?.filter(role => role.enabled).map(role => <option key={role.id} value={role.id}>{role.name} · {role.runtime_id}</option>)}</select></Field></div>
      <DelegationFields draft={draft} setDraft={setDraft} />
      <div className="flex gap-1 rounded-xl border border-line p-1"><button type="button" className={tabClass(tab === "chat")} onClick={() => setTab("chat")}><MessagesSquare size={14} className="mr-1 inline" />助手对话</button><button type="button" className={tabClass(tab === "test")} onClick={() => setTab("test")}><FlaskConical size={14} className="mr-1 inline" />测试</button></div>
      {tab === "chat" ? <div className="grid gap-3">
        <div className="max-h-52 overflow-auto rounded-xl bg-elevated p-3 text-sm">{creatorMessages.length ? creatorMessages.map((msg, index) => <div key={index} className="mb-2"><b className="text-ink">{msg.role === "user" ? "你" : "助手"}</b><p className="whitespace-pre-wrap text-muted">{msg.content}</p></div>) : <p className="text-muted">向助手描述你想创建的角色，或要求它检查/修改当前草稿。回复可能附带新的角色草稿。</p>}</div>
        <div className="flex gap-2"><textarea className={inputClass + " min-h-16 py-3"} value={chatMsg} onChange={e => setChatMsg(e.target.value)} placeholder="例如：帮我检查当前草稿，并补充适合资深后端工程师的系统提示词…" /><Button variant="primary" disabled={!chatMsg.trim() || chat.isPending} onClick={() => chat.mutate()}>发送</Button></div>
      </div> : <div className="grid gap-3">
        <div className="max-h-32 overflow-auto rounded-xl bg-elevated p-3 text-sm">{testMessages.map((msg, index) => <div key={index} className="mb-2"><b className="text-ink">{msg.role === "user" ? "测试输入" : "助手"}</b><p className="whitespace-pre-wrap text-muted">{msg.content}</p></div>)}</div>
        <div className="flex gap-2"><input className={inputClass} value={testMsg} onChange={e => setTestMsg(e.target.value)} placeholder="输入测试消息，模拟角色实际执行…" onKeyDown={e => { if (e.key === "Enter" && testMsg.trim() && !test.isPending) test.mutate(); }} /><Button disabled={!testMsg.trim() || test.isPending} onClick={() => test.mutate()}>运行测试</Button></div>
        {test.isPending ? <Spinner label="测试执行中" /> : testOutput ? <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded-xl bg-[#080d15] p-3 text-xs leading-5 text-slate-200">{testOutput}</pre> : null}
      </div>}
      <MutationError value={save.error} />
      <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>关闭</Button><Button variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>保存角色</Button></div>
    </div>
  </Dialog>;
}
