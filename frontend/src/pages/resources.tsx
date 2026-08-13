import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CirclePlus, Download, Pencil, RefreshCcw, Trash2 } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import { PageHeader } from "../components/shell";
import { Badge, Button, Card, Dialog, Empty, Field, inputClass, Spinner, useToast } from "../components/ui";
import { api, keys } from "../lib/api";
import type { Project, ProvisionInfo, Role, RoleConfig, RuntimeDescriptor, RuntimeField, Skill } from "../types";

function MutationError({ value }: { value: unknown }) {
  return value instanceof Error ? <p role="alert" className="text-sm text-danger">{value.message}</p> : null;
}

export function ProjectsPage() {
  const query = useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/projects") });
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<Partial<Project> | null>(null);
  const save = useMutation({
    mutationFn: (value: Partial<Project>) => value.id
      ? api<Project>(`/projects/${value.id}`, { method: "PATCH", revision: value.revision, body: { name: value.name, description: value.description, project_dir: value.project_dir, status: value.status } })
      : api<Project>("/projects", { method: "POST", body: value }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: keys.projects }); setEditing(null); toast("项目已保存"); }
  });
  const remove = useMutation({ mutationFn: (value: Project) => api<void>(`/projects/${value.id}`, { method: "DELETE", revision: value.revision }), onSuccess: () => qc.invalidateQueries({ queryKey: keys.projects }) });
  return <>
    <PageHeader kicker="Workspace boundaries" title="项目" copy="项目定义代码目录、隔离边界与工作流归属。" actions={<Button variant="primary" onClick={() => setEditing({ status: "active" })}><CirclePlus size={17} />新建项目</Button>} />
    {query.isLoading ? <Spinner /> : query.data?.length ? <div className="grid gap-4 lg:grid-cols-2">{query.data.map(project => <Card key={project.id}>
      <div className="flex items-start gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{project.name}</h2><Badge tone={project.status === "active" ? "good" : "neutral"}>{project.status === "active" ? "活跃" : "归档"}</Badge>{project.is_git && <Badge tone="info">Git</Badge>}</div><p className="mt-2 text-sm leading-6 text-muted">{project.description || "暂无说明"}</p><code className="mt-3 block truncate rounded-lg bg-elevated px-3 py-2 text-xs text-muted">{project.project_dir || "未绑定目录"}</code></div>
      <div className="ml-auto flex gap-1"><Button size="sm" variant="ghost" aria-label={`编辑 ${project.name}`} onClick={() => setEditing(project)}><Pencil size={15} /></Button><Button size="sm" variant="danger" aria-label={`删除 ${project.name}`} onClick={() => confirm(`删除项目“${project.name}”？`) && remove.mutate(project)}><Trash2 size={15} /></Button></div></div>
    </Card>)}</div> : <Empty title="还没有项目" copy="创建项目并绑定代码目录，任务和工作流才有明确的执行边界。" />}
    <Dialog open={editing !== null} onOpenChange={open => !open && setEditing(null)} title={editing?.id ? "编辑项目" : "新建项目"}>
      {editing && <form className="grid gap-4" onSubmit={(event: FormEvent) => { event.preventDefault(); save.mutate(editing); }}>
        <Field label="名称"><input className={inputClass} required value={editing.name || ""} onChange={e => setEditing({ ...editing, name: e.target.value })} /></Field>
        <Field label="说明"><textarea className={inputClass + " min-h-24 py-3"} value={editing.description || ""} onChange={e => setEditing({ ...editing, description: e.target.value })} /></Field>
        <Field label="代码目录" hint="使用主机上的绝对路径。"><input className={inputClass} value={editing.project_dir || ""} onChange={e => setEditing({ ...editing, project_dir: e.target.value })} /></Field>
        {editing.id && <Field label="状态"><select className={inputClass} value={editing.status} onChange={e => setEditing({ ...editing, status: e.target.value as Project["status"] })}><option value="active">活跃</option><option value="archived">归档</option></select></Field>}
        <MutationError value={save.error} /><div className="flex justify-end"><Button variant="primary" disabled={save.isPending}>保存</Button></div>
      </form>}
    </Dialog>
  </>;
}

type RoleDraft = Partial<Role> & { role_config: RoleConfig };

export function RolesPage() {
  const roles = useQuery({ queryKey: keys.roles, queryFn: () => api<Role[]>("/roles") });
  const runtimes = useQuery({ queryKey: keys.runtimes, queryFn: () => api<RuntimeDescriptor[]>("/runtimes") });
  const skills = useQuery({ queryKey: keys.skills, queryFn: () => api<Skill[]>("/skills") });
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<RoleDraft | null>(null);
  const selected = runtimes.data?.find(runtime => runtime.id === draft?.runtime_id);
  const save = useMutation({
    mutationFn: (value: RoleDraft) => value.id
      ? api<Role>(`/roles/${value.id}`, { method: "PATCH", revision: value.revision, body: rolePayload(value) })
      : api<Role>("/roles", { method: "POST", body: rolePayload(value) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: keys.roles }); setDraft(null); toast("角色已保存"); }
  });
  const remove = useMutation({ mutationFn: (value: Role) => api<void>(`/roles/${value.id}`, { method: "DELETE", revision: value.revision }), onSuccess: () => qc.invalidateQueries({ queryKey: keys.roles }) });
  return <>
    <PageHeader kicker="Responsibility profiles" title="角色" copy="角色只描述职责与策略；具体命令翻译由 Runtime 承担。" actions={<Button variant="primary" onClick={() => setDraft({ runtime_id: runtimes.data?.[0]?.id || "pi", max_concurrency: 1, enabled: true, role_config: {} })}><CirclePlus size={17} />新建角色</Button>} />
    {roles.isLoading ? <Spinner /> : roles.data?.length ? <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">{roles.data.map(role => <Card key={role.id}>
      <div className="flex items-start gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{role.name}</h2><Badge tone={role.enabled ? "good" : "neutral"}>{role.enabled ? "启用" : "停用"}</Badge></div><p className="mt-2 min-h-10 text-sm leading-5 text-muted">{role.description || "暂无职责说明"}</p></div><Button size="sm" variant="ghost" className="ml-auto" aria-label={`编辑 ${role.name}`} onClick={() => setDraft({ ...role, role_config: role.role_config || {} })}><Pencil size={15} /></Button></div>
      <div className="mt-4 flex flex-wrap gap-2"><Badge tone="info">{role.runtime_id}</Badge><Badge>并发 {role.max_concurrency}</Badge>{role.role_config.model && <Badge>{role.role_config.model}</Badge>}</div>
      <Button size="sm" variant="danger" className="mt-4" onClick={() => confirm(`删除角色“${role.name}”？`) && remove.mutate(role)}><Trash2 size={15} />删除</Button>
    </Card>)}</div> : <Empty title="还没有角色" copy="先创建承担执行、评审或研究职责的角色。" />}
    <Dialog open={draft !== null} onOpenChange={open => !open && setDraft(null)} title={draft?.id ? "编辑角色" : "新建角色"} wide>
      {draft && <form className="grid gap-5" onSubmit={(event: FormEvent) => { event.preventDefault(); save.mutate(draft); }}>
        <div className="grid gap-4 md:grid-cols-2"><Field label="名称"><input className={inputClass} required value={draft.name || ""} onChange={e => setDraft({ ...draft, name: e.target.value })} /></Field><Field label="Runtime"><select className={inputClass} value={draft.runtime_id} onChange={e => setDraft({ ...draft, runtime_id: e.target.value, role_config: {} })}>{runtimes.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field></div>
        <Field label="职责说明"><textarea className={inputClass + " min-h-24 py-3"} value={draft.description || ""} onChange={e => setDraft({ ...draft, description: e.target.value })} /></Field>
        <div className="grid gap-4 md:grid-cols-2">{selected?.fields.map(field => <RuntimeFieldInput key={field.key} field={resolveRuntimeField(field, draft.role_config, skills.data)} value={field.builtin ? draft.role_config[field.key as keyof RoleConfig] : draft.role_config.custom?.[field.key]} onChange={value => setDraft({ ...draft, role_config: field.builtin ? { ...draft.role_config, [field.key]: value } : { ...draft.role_config, custom: { ...draft.role_config.custom, [field.key]: String(value) } } })} />)}</div>
        <div className="grid gap-4 md:grid-cols-2"><Field label="最大并发"><input className={inputClass} type="number" min="1" value={draft.max_concurrency || 1} onChange={e => setDraft({ ...draft, max_concurrency: Number(e.target.value) })} /></Field><label className="mt-7 flex min-h-11 items-center gap-3 rounded-xl border border-line bg-elevated px-3 text-sm"><input type="checkbox" checked={draft.enabled ?? true} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />启用角色</label></div>
        <MutationError value={save.error} /><div className="flex justify-end"><Button variant="primary" disabled={save.isPending}>保存角色</Button></div>
      </form>}
    </Dialog>
  </>;
}

function resolveRuntimeField(field: RuntimeField, config: RoleConfig, skills?: Skill[]): RuntimeField {
  if (field.source === "skills") return { ...field, suggestions: skills?.map(skill => skill.dir) || [] };
  if (field.key === "thinking" && config.model && field.thinking_options_by_model?.[config.model]) {
    return { ...field, options: ["", ...field.thinking_options_by_model[config.model].filter(option => option !== "")] };
  }
  return field;
}

function RuntimeFieldInput({ field, value, onChange }: { field: RuntimeField; value: unknown; onChange(value: unknown): void }) {
  const effectiveValue = value === undefined ? field.default : value;
  const text = Array.isArray(effectiveValue) ? effectiveValue.join("\n") : field.type === "env" && effectiveValue && typeof effectiveValue === "object" ? Object.entries(effectiveValue).map(([key, item]) => `${key}=${item}`).join("\n") : typeof effectiveValue === "string" ? effectiveValue : "";
  if (field.type === "list" && field.suggestions?.length) {
    const selected = new Set(Array.isArray(effectiveValue) ? effectiveValue : text.split(/[\n,]/).map(item => item.trim()).filter(Boolean));
    const toggle = (option: string, checked: boolean) => {
      const next = new Set(selected);
      if (checked) next.add(option); else next.delete(option);
      const values = field.suggestions?.filter(item => next.has(item)) || [];
      onChange(field.builtin ? values : values.join(","));
    };
    return <fieldset className="grid gap-2 rounded-xl border border-line bg-elevated p-3"><legend className="px-1 text-sm font-medium text-ink">{field.label}</legend><div className="grid max-h-44 gap-2 overflow-auto">{field.suggestions.map(option => <label key={option} className="flex min-h-9 items-center gap-2 text-xs font-normal text-ink"><input type="checkbox" checked={selected.has(option)} onChange={event => toggle(option, event.target.checked)} /><span className="min-w-0 break-all">{option}</span></label>)}</div>{field.help && <p className="text-xs leading-5 text-muted">{field.help}</p>}</fieldset>;
  }
  if (field.type === "textarea" || field.type === "list" || field.type === "env" || field.key === "extra_args") return <Field label={field.label} hint={field.help}><textarea className={inputClass + " min-h-24 py-3"} placeholder={field.placeholder} value={text} onChange={e => {
    if (!field.builtin) onChange(e.target.value);
    else if (field.type === "list" || field.key === "extra_args") onChange(e.target.value.split("\n").map(v => v.trim()).filter(Boolean));
    else if (field.type === "env") onChange(Object.fromEntries(e.target.value.split("\n").map(line => line.split("=", 2)).filter(parts => parts[0]).map(([key, item = ""]) => [key.trim(), item])));
    else onChange(e.target.value);
  }} /></Field>;
  if (field.type === "select") return <Field label={field.label} hint={field.help}><select className={inputClass} value={text} onChange={e => onChange(e.target.value)}><option value="">使用 Runtime 默认值</option>{field.options?.map(option => <option key={option}>{option}</option>)}</select></Field>;
  return <Field label={field.label} hint={field.help}><input className={inputClass} list={`runtime-${field.key}`} placeholder={field.placeholder} value={text} onChange={e => onChange(e.target.value)} />{field.suggestions?.length ? <datalist id={`runtime-${field.key}`}>{field.suggestions.map(option => <option key={option} value={option} />)}</datalist> : null}</Field>;
}

function rolePayload(value: RoleDraft) {
  return { name: value.name, description: value.description || "", runtime_id: value.runtime_id, role_config: value.role_config, max_concurrency: value.max_concurrency || 1, enabled: value.enabled ?? true };
}

export function RuntimesPage() {
  const runtimes = useQuery({ queryKey: keys.runtimes, queryFn: () => api<RuntimeDescriptor[]>("/runtimes") });
  const provisioning = useQuery({ queryKey: keys.provisioning, queryFn: () => api<ProvisionInfo[]>("/runtimes/provisioning") });
  const qc = useQueryClient();
  const refresh = useMutation({ mutationFn: () => api<RuntimeDescriptor[]>("/runtimes/refresh", { method: "POST" }), onSuccess: () => qc.invalidateQueries({ queryKey: keys.runtimes }) });
  const install = useMutation({ mutationFn: (runtime_id: string) => api("/runtimes/install", { method: "POST", body: { runtime_id } }), onSuccess: () => qc.invalidateQueries({ queryKey: keys.provisioning }) });
  const byID = useMemo(() => new Map(provisioning.data?.map(item => [item.id, item])), [provisioning.data]);
  return <>
    <PageHeader kicker="Execution providers" title="Runtime" copy="Runtime 目录统一声明批处理、结构化会话、技能与安装能力。" actions={<Button onClick={() => refresh.mutate()} disabled={refresh.isPending}><RefreshCcw size={16} />刷新模型与健康状态</Button>} />
    {runtimes.isLoading ? <Spinner /> : <div className="grid gap-4 lg:grid-cols-2">{runtimes.data?.map(runtime => { const provision = byID.get(runtime.id); return <Card key={runtime.id}>
      <div className="flex items-start gap-3"><div><div className="flex items-center gap-2"><h2 className="font-semibold">{runtime.name}</h2><Badge tone={runtime.healthy ? "good" : "bad"}>{runtime.healthy ? "可用" : "不可用"}</Badge></div><a className="mt-1 block text-xs text-brand-soft hover:underline" href={runtime.docs} target="_blank" rel="noreferrer">官方文档</a></div>{!provision?.installed && <Button className="ml-auto" size="sm" variant="primary" onClick={() => install.mutate(runtime.id)}><Download size={15} />安装</Button>}</div>
      {runtime.health && <p className="mt-3 text-sm text-muted">{runtime.health}</p>}<div className="mt-4 flex flex-wrap gap-2">{runtime.capabilities.map(cap => <Badge key={cap} tone="info">{cap}</Badge>)}</div><div className="mt-4 text-xs text-muted">{runtime.models?.length || 0} 个可用模型 · {runtime.fields.length} 个配置字段</div>
    </Card>; })}</div>}
  </>;
}
