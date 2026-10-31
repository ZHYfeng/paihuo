import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CirclePlus, Copy, MessagesSquare, Pencil, Search, Trash2 } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import { PageHeader } from "../../components/shell";
import { MutationError } from "../../components/project/mutation-error";
import { RoleDetailDialog, RoleStudioDialog } from "../../components/role/dialogs";
import { DelegationFields, RoleFieldGroups, rolePayload, type RoleDraft } from "../../components/role/form";
import { Badge, Button, Card, Dialog, Empty, Field, inputClass, Spinner, useToast } from "../../components/ui";
import { api, keys } from "../../lib/api";
import type { Role, RoleStudioDraft, RuntimeDescriptor, Skill, Task } from "../../types";

export function RolesPage() {
  const roles = useQuery({ queryKey: keys.roles, queryFn: () => api<Role[]>("/roles") });
  const tasks = useQuery({ queryKey: keys.tasks, queryFn: () => api<Task[]>("/tasks") });
  const runtimes = useQuery({ queryKey: keys.runtimes, queryFn: () => api<RuntimeDescriptor[]>("/runtimes") });
  const skills = useQuery({ queryKey: keys.skills, queryFn: () => api<Skill[]>("/skills") });
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<RoleDraft | null>(null);
  const [detail, setDetail] = useState<Role | null>(null);
  const [studio, setStudio] = useState<{ role?: Role; draft: RoleStudioDraft } | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("name");
  const [view, setView] = useState<"grid" | "table">("grid");
  const selected = runtimes.data?.find(runtime => runtime.id === draft?.runtime_id);
  const visible = useMemo(() => {
    let list = roles.data || [];
    const q = search.trim().toLowerCase();
    if (q) list = list.filter(role => {
      const rc = role.role_config || {};
      return [role.name, role.description, role.runtime_id, rc.model].some(value => String(value || "").toLowerCase().includes(q));
    });
    const copy = [...list];
    switch (sort) {
      case "created": copy.sort((a, b) => b.created_at.localeCompare(a.created_at)); break;
      case "concurrency": copy.sort((a, b) => b.max_concurrency - a.max_concurrency); break;
      case "runtime": copy.sort((a, b) => a.runtime_id.localeCompare(b.runtime_id)); break;
      default: copy.sort((a, b) => a.name.localeCompare(b.name));
    }
    return copy;
  }, [roles.data, search, sort]);
  const save = useMutation({
    mutationFn: (value: RoleDraft) => value.id
      ? api<Role>(`/roles/${value.id}`, { method: "PATCH", revision: value.revision, body: rolePayload(value) })
      : api<Role>("/roles", { method: "POST", body: rolePayload(value) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: keys.roles }); setDraft(null); toast("角色已保存"); }
  });
  const remove = useMutation({ mutationFn: (value: Role) => api<void>(`/roles/${value.id}`, { method: "DELETE", revision: value.revision }), onSuccess: () => qc.invalidateQueries({ queryKey: keys.roles }) });
  const toggle = useMutation({
    mutationFn: (value: Role) => api<Role>(`/roles/${value.id}`, { method: "PATCH", revision: value.revision, body: { enabled: !value.enabled } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: keys.roles }); },
    onError: error => toast((error as Error).message, "bad")
  });
  const duplicate = useMutation({
    mutationFn: (value: Role) => api<Role>("/roles", { method: "POST", body: { ...rolePayload({ ...value, role_config: value.role_config || {} }), name: `${value.name}（副本）` } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: keys.roles }); toast("已复制角色"); },
    onError: error => toast((error as Error).message, "bad")
  });
  const roleStats = useMemo(() => {
    const out = new Map<number, { total: number; inFlight: number; review: number }>();
    for (const task of tasks.data || []) {
      if (!task.role_id) continue;
      const stat = out.get(task.role_id) || { total: 0, inFlight: 0, review: 0 };
      stat.total++;
      if (["queued", "claimed", "running", "awaiting_review"].includes(task.status)) stat.inFlight++;
      if (task.status === "awaiting_review") stat.review++;
      out.set(task.role_id, stat);
    }
    return out;
  }, [tasks.data]);
  return <>
    <PageHeader title="角色" copy="定义职责、能力与执行约束，把工作交给合适的角色。" actions={<><Button onClick={() => setStudio({ draft: { name: "", description: "", runtime_id: runtimes.data?.[0]?.id || "pi", max_concurrency: 1, delegation_enabled: false, delegation_max_perm: "review", role_config: {} } })}><MessagesSquare size={16} />角色助手</Button><Button variant="primary" onClick={() => setDraft({ runtime_id: runtimes.data?.[0]?.id || "pi", max_concurrency: 1, delegation_enabled: false, delegation_max_perm: "review", enabled: true, role_config: {} })}><CirclePlus size={17} />新建角色</Button></>} />
    <Card className="mb-4 flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
      <span className="flex items-center gap-2 px-2 text-sm text-muted"><Search size={16} />搜索</span>
      <input className={inputClass + " sm:w-64"} placeholder="搜索角色…" value={search} onChange={e => setSearch(e.target.value)} aria-label="搜索角色" />
      <select className={inputClass + " sm:w-44"} value={sort} onChange={e => setSort(e.target.value)} aria-label="角色排序"><option value="name">名称 A-Z</option><option value="created">最近创建</option><option value="concurrency">并发：高到低</option><option value="runtime">智能体</option></select>
      <span className="text-sm text-muted sm:ml-auto">{visible.length} 个角色</span>
      <div className="flex rounded-xl border border-line bg-elevated p-0.5" role="tablist" aria-label="视图切换">
        <button role="tab" aria-selected={view === "grid"} className={`rounded-[10px] px-2.5 py-1 text-[13px] ${view === "grid" ? "bg-surface font-semibold text-ink shadow-sm" : "text-muted"}`} onClick={() => setView("grid")}>卡片</button>
        <button role="tab" aria-selected={view === "table"} className={`rounded-[10px] px-2.5 py-1 text-[13px] ${view === "table" ? "bg-surface font-semibold text-ink shadow-sm" : "text-muted"}`} onClick={() => setView("table")}>表格</button>
      </div>
    </Card>
    {roles.isLoading ? <Spinner /> : !visible.length ? <Empty title={search ? "没有匹配的角色" : "还没有角色"} copy={search ? "尝试清除搜索词，查看全部任务角色。" : "先创建承担执行、评审或研究职责的角色。"} action={!search ? <Button size="sm" variant="primary" onClick={() => setDraft({ runtime_id: runtimes.data?.[0]?.id || "pi", max_concurrency: 1, delegation_enabled: false, delegation_max_perm: "review", enabled: true, role_config: {} })}>创建角色</Button> : undefined} /> : view === "grid" ? <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">{visible.map(role => {
    const stat = roleStats.get(role.id) || { total: 0, inFlight: 0, review: 0 };
    return <Card key={role.id}>
      <div className="flex items-start gap-3"><div className="min-w-0"><button className="text-left" onClick={() => setDetail(role)}><h2 className="font-semibold hover:text-brand-soft">{role.name}</h2></button><div className="flex flex-wrap items-center gap-2"><Badge tone={role.enabled ? "good" : "neutral"}>{role.enabled ? "启用" : "停用"}</Badge></div><p className="mt-2 min-h-10 text-sm leading-5 text-muted">{role.description || "未设置描述"}</p></div><Button size="sm" variant="ghost" className="ml-auto" aria-label={`编辑 ${role.name}`} onClick={() => setDraft({ ...role, role_config: role.role_config || {} })}><Pencil size={15} /></Button></div>
      <div className="mt-3 flex flex-wrap gap-2"><Badge tone="info">{role.runtime_id}</Badge><span title="默认模型"><Badge>{role.role_config.model || "默认模型"}</Badge></span><span title="同一角色最多同时运行的任务数"><Badge>并发 {role.max_concurrency}</Badge></span>{role.delegation_enabled ? <span title="可派生子任务"><Badge tone="good">编排者</Badge></span> : null}</div>
      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted"><span><b>{stat.total}</b> 任务</span><span><b style={{ color: "var(--st-running)" }}>{stat.inFlight}</b> 进行中</span><span><b style={{ color: "var(--st-review)" }}>{stat.review}</b> 待审批</span></div>
      <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="ghost" onClick={() => setDetail(role)}>详情</Button><Button size="sm" variant="ghost" onClick={() => setStudio({ role, draft: { name: role.name, description: role.description, runtime_id: role.runtime_id, max_concurrency: role.max_concurrency, delegation_enabled: role.delegation_enabled ?? false, delegation_max_perm: role.delegation_max_perm || "review", role_config: role.role_config || {} } })}>助手</Button><Button size="sm" variant="ghost" onClick={() => duplicate.mutate(role)}><Copy size={14} />复制</Button><Button size="sm" variant="ghost" onClick={() => toggle.mutate(role)}>{role.enabled ? "停用" : "启用"}</Button><Button size="sm" variant="danger" className="ml-auto" onClick={() => confirm(`删除角色“${role.name}”？`) && remove.mutate(role)}><Trash2 size={14} />删除</Button></div>
    </Card>;
  })}</div> : <Card className="overflow-x-auto p-0"><table className="w-full text-sm"><thead><tr className="border-b border-line text-left text-xs text-faint">
    <th className="whitespace-nowrap px-3 py-2 font-medium">角色</th><th className="whitespace-nowrap px-3 py-2 font-medium">智能体</th><th className="whitespace-nowrap px-3 py-2 font-medium">模型</th><th className="whitespace-nowrap px-3 py-2 font-medium">最大并发</th><th className="whitespace-nowrap px-3 py-2 font-medium">任务</th><th className="whitespace-nowrap px-3 py-2 font-medium">进行中</th><th className="whitespace-nowrap px-3 py-2 font-medium">待审批</th><th className="whitespace-nowrap px-3 py-2 font-medium">状态</th><th className="whitespace-nowrap px-3 py-2 font-medium">操作</th>
  </tr></thead><tbody className="divide-y divide-line">{visible.map(role => { const stat = roleStats.get(role.id) || { total: 0, inFlight: 0, review: 0 }; return <tr key={role.id} className="hover:bg-hover">
    <td className="px-3 py-2"><button className="text-left font-medium hover:text-brand-soft" onClick={() => setDetail(role)}>{role.name}</button><div className="mt-0.5 max-w-72 truncate text-xs text-faint">{role.description || "未设置描述"}</div></td>
    <td className="px-3 py-2"><Badge tone="info">{role.runtime_id}</Badge></td>
    <td className="px-3 py-2 text-muted">{role.role_config.model || "默认"}</td>
    <td className="px-3 py-2 text-muted">{role.max_concurrency}</td>
    <td className="px-3 py-2">{role.delegation_enabled ? <Badge tone="good">编排者 · {role.delegation_max_perm === "full" ? "full" : "review"}</Badge> : <span className="text-faint">—</span>}</td>
    <td className="px-3 py-2 text-muted">{stat.total}</td>
    <td className="px-3 py-2 text-muted">{stat.inFlight}</td>
    <td className="px-3 py-2 text-muted">{stat.review}</td>
    <td className="px-3 py-2"><Badge tone={role.enabled ? "good" : "neutral"}>{role.enabled ? "启用" : "停用"}</Badge></td>
    <td className="px-3 py-2"><span className="inline-flex gap-1.5"><Button size="sm" variant="ghost" onClick={() => setDraft({ ...role, role_config: role.role_config || {} })}>编辑</Button><Button size="sm" variant="ghost" onClick={() => duplicate.mutate(role)}>复制</Button><Button size="sm" variant="ghost" onClick={() => toggle.mutate(role)}>{role.enabled ? "停用" : "启用"}</Button><Button size="sm" variant="danger" onClick={() => confirm(`删除角色“${role.name}”？`) && remove.mutate(role)}><Trash2 size={14} />删除</Button></span></td>
  </tr>; })}</tbody></table></Card>}
    <Dialog open={draft !== null} onOpenChange={open => !open && setDraft(null)} title={draft?.id ? "编辑角色" : "新建角色"} wide>
      {draft && <form className="grid gap-4" onSubmit={(event: FormEvent) => { event.preventDefault(); save.mutate(draft); }}>
        <div className="grid gap-4 md:grid-cols-2"><Field label="名称"><input className={inputClass} required value={draft.name || ""} onChange={e => setDraft({ ...draft, name: e.target.value })} /></Field><Field label="Runtime"><select className={inputClass} value={draft.runtime_id} onChange={e => setDraft({ ...draft, runtime_id: e.target.value, role_config: {} })}>{runtimes.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field></div>
        <Field label="职责说明"><textarea className={inputClass + " min-h-24 py-3"} value={draft.description || ""} onChange={e => setDraft({ ...draft, description: e.target.value })} /></Field>
        <div>{selected?.fields?.length ? <RoleFieldGroups fields={selected.fields} draft={draft} setDraft={setDraft} skills={skills.data} /> : null}</div>
        <div className="grid gap-4 md:grid-cols-2"><Field label="最大并发"><input className={inputClass} type="number" min="1" value={draft.max_concurrency || 1} onChange={e => setDraft({ ...draft, max_concurrency: Number(e.target.value) })} /></Field><label className="flex min-h-11 items-center gap-3 self-end rounded-xl border border-line bg-elevated px-3 text-sm"><input type="checkbox" checked={draft.enabled ?? true} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />启用角色</label></div>
        <DelegationFields draft={draft} setDraft={setDraft} />
        <MutationError value={save.error} /><div className="flex justify-end"><Button variant="primary" disabled={save.isPending}>保存角色</Button></div>
      </form>}
    </Dialog>
    {detail && <RoleDetailDialog role={detail} onClose={() => setDetail(null)} />}
    {studio && <RoleStudioDialog initial={studio} onClose={() => setStudio(null)} />}
  </>;
}
