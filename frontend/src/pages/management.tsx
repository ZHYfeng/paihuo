import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, CirclePlus, FolderSearch, Pencil, Save, Trash2 } from "lucide-react";
import { FormEvent, useState } from "react";
import { Markdown } from "../components/markdown";
import { PageHeader } from "../components/shell";
import { Badge, Button, Card, Dialog, Empty, Field, inputClass, Spinner, useToast } from "../components/ui";
import { api, keys } from "../lib/api";
import type { Project, Role, Schedule, Skill, TaskTemplate } from "../types";

export function SkillsPage() {
  const skills = useQuery({ queryKey: keys.skills, queryFn: () => api<Skill[]>("/skills") });
  const qc = useQueryClient();
  const [path, setPath] = useState("");
  const [detail, setDetail] = useState<(Skill & { content: string }) | null>(null);
  const importOne = useMutation({ mutationFn: () => api<Skill>("/skills", { method: "POST", body: { source_path: path, tags: [] } }), onSuccess: () => { setPath(""); qc.invalidateQueries({ queryKey: keys.skills }); } });
  const scan = useMutation({ mutationFn: () => api("/skills/scan", { method: "POST", body: { source_path: path, tags: [] } }), onSuccess: () => qc.invalidateQueries({ queryKey: keys.skills }) });
  const remove = useMutation({ mutationFn: (id: number) => api(`/skills/${id}`, { method: "DELETE" }), onSuccess: () => qc.invalidateQueries({ queryKey: keys.skills }) });
  return <>
    <PageHeader kicker="Reusable capabilities" title="技能" copy="导入带 SKILL.md 的目录；角色只保存技能选择，执行时由平台物化挂载。" />
    <Card className="mb-5"><form className="flex flex-col gap-3 sm:flex-row" onSubmit={e => { e.preventDefault(); importOne.mutate(); }}><input className={inputClass} required placeholder="技能目录绝对路径" value={path} onChange={e => setPath(e.target.value)} /><Button variant="primary"><CirclePlus size={16} />导入</Button><Button type="button" onClick={() => scan.mutate()}><FolderSearch size={16} />递归扫描</Button></form>{(importOne.error || scan.error) instanceof Error && <p className="mt-3 text-sm text-danger">{(importOne.error || scan.error as Error).message}</p>}</Card>
    {skills.isLoading ? <Spinner /> : skills.data?.length ? <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">{skills.data.map(skill => <Card key={skill.id}><div className="flex items-start gap-3"><button className="min-w-0 text-left" onClick={async () => setDetail(await api(`/skills/${skill.id}`))}><h2 className="font-semibold hover:text-brand-soft">{skill.name}</h2><p className="mt-2 text-sm leading-5 text-muted">{skill.description || "暂无说明"}</p></button><Button variant="danger" size="sm" className="ml-auto" aria-label={`删除 ${skill.name}`} onClick={() => confirm(`删除技能“${skill.name}”？`) && remove.mutate(skill.id)}><Trash2 size={15} /></Button></div><div className="mt-4 flex flex-wrap gap-2">{skill.tags?.map(tag => <Badge key={tag}>{tag}</Badge>)}</div></Card>)}</div> : <Empty title="技能库为空" copy="从一个包含 SKILL.md 的目录开始导入。" />}
    <Dialog open={detail !== null} onOpenChange={open => !open && setDetail(null)} title={detail?.name || "技能详情"} wide>{detail && <Markdown>{detail.content}</Markdown>}</Dialog>
  </>;
}

type ScheduleDraft = Partial<Schedule>;

export function SchedulesPage() {
  const schedules = useQuery({ queryKey: ["schedules"], queryFn: () => api<Schedule[]>("/schedules") });
  const roles = useQuery({ queryKey: keys.roles, queryFn: () => api<Role[]>("/roles") });
  const projects = useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/projects") });
  const qc = useQueryClient();
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const save = useMutation({ mutationFn: (value: ScheduleDraft) => value.id ? api(`/schedules/${value.id}`, { method: "PATCH", revision: value.revision, body: schedulePayload(value) }) : api("/schedules", { method: "POST", body: schedulePayload(value) }), onSuccess: () => { setDraft(null); qc.invalidateQueries({ queryKey: ["schedules"] }); } });
  const remove = useMutation({ mutationFn: (value: Schedule) => api(`/schedules/${value.id}`, { method: "DELETE", revision: value.revision }), onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }) });
  return <>
    <PageHeader kicker="Cron automation" title="定时任务" copy="按 cron 创建普通任务，后续仍遵守同一依赖、权限和并发策略。" actions={<Button variant="primary" onClick={() => setDraft({ perm: "full", enabled: true, block_on_failure: true })}><CalendarPlus size={16} />新建定时任务</Button>} />
    {schedules.isLoading ? <Spinner /> : schedules.data?.length ? <div className="grid gap-3">{schedules.data.map(item => <Card key={item.id} className="flex flex-col gap-4 sm:flex-row sm:items-center"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{item.name}</h2><Badge tone={item.enabled ? "good" : "neutral"}>{item.enabled ? "启用" : "停用"}</Badge><code className="text-xs text-brand-soft">{item.cron}</code></div><p className="mt-2 truncate text-sm text-muted">{item.title_template} · {item.role_name || `角色 #${item.role_id}`}</p></div><div className="flex gap-2"><Button size="sm" onClick={() => setDraft(item)}><Pencil size={15} />编辑</Button><Button size="sm" variant="danger" onClick={() => confirm(`删除“${item.name}”？`) && remove.mutate(item)}><Trash2 size={15} /></Button></div></Card>)}</div> : <Empty title="没有定时任务" copy="为周期性检查、同步或报告创建一条 cron 规则。" />}
    <Dialog open={draft !== null} onOpenChange={open => !open && setDraft(null)} title={draft?.id ? "编辑定时任务" : "新建定时任务"} wide>{draft && <form className="grid gap-4" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(draft); }}>
      <div className="grid gap-4 md:grid-cols-2"><Field label="名称"><input className={inputClass} required value={draft.name || ""} onChange={e => setDraft({ ...draft, name: e.target.value })} /></Field><Field label="Cron（秒 分 时 日 月 周）"><input className={inputClass} required placeholder="0 0 9 * * 1-5" value={draft.cron || ""} onChange={e => setDraft({ ...draft, cron: e.target.value })} /></Field></div>
      <Field label="任务标题"><input className={inputClass} required value={draft.title_template || ""} onChange={e => setDraft({ ...draft, title_template: e.target.value })} /></Field><Field label="任务说明"><textarea className={inputClass + " min-h-28 py-3"} value={draft.body_template || ""} onChange={e => setDraft({ ...draft, body_template: e.target.value })} /></Field>
      <div className="grid gap-4 md:grid-cols-2"><Field label="角色"><select className={inputClass} required value={draft.role_id || ""} onChange={e => setDraft({ ...draft, role_id: Number(e.target.value) })}><option value="">请选择</option>{roles.data?.filter(r => r.enabled).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field><Field label="项目"><select className={inputClass} value={draft.project_id || ""} onChange={e => setDraft({ ...draft, project_id: e.target.value ? Number(e.target.value) : null })}><option value="">不绑定项目</option>{projects.data?.filter(p => p.status === "active").map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field></div>
      <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={draft.enabled ?? true} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />启用</label>{save.error instanceof Error && <p className="text-sm text-danger">{save.error.message}</p>}<div className="flex justify-end"><Button variant="primary">保存</Button></div>
    </form>}</Dialog>
  </>;
}

function schedulePayload(value: ScheduleDraft) { return { name: value.name, cron: value.cron, title_template: value.title_template, body_template: value.body_template || "", role_id: value.role_id, project_id: value.project_id || null, perm: value.perm || "full", block_on_failure: value.block_on_failure ?? true, enabled: value.enabled ?? true }; }

export function TemplatesPage() {
  const templates = useQuery({ queryKey: ["templates"], queryFn: () => api<TaskTemplate[]>("/templates") });
  const roles = useQuery({ queryKey: keys.roles, queryFn: () => api<Role[]>("/roles") });
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Partial<TaskTemplate> | null>(null);
  const save = useMutation({ mutationFn: (value: Partial<TaskTemplate>) => value.id ? api(`/templates/${value.id}`, { method: "PATCH", body: { name: value.name, body: value.body, role_id: value.role_id || null } }) : api("/templates", { method: "POST", body: { name: value.name, body: value.body, role_id: value.role_id || null } }), onSuccess: () => { setDraft(null); qc.invalidateQueries({ queryKey: ["templates"] }); } });
  const remove = useMutation({ mutationFn: (id: number) => api(`/templates/${id}`, { method: "DELETE" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["templates"] }) });
  return <><PageHeader kicker="Prompt library" title="模板" copy="维护可复用的任务说明，并可预选执行角色。" actions={<Button variant="primary" onClick={() => setDraft({})}><CirclePlus size={16} />新建模板</Button>} />
    {templates.isLoading ? <Spinner /> : templates.data?.length ? <div className="grid gap-4 lg:grid-cols-2">{templates.data.map(item => <Card key={item.id}><div className="flex items-start gap-3"><div className="min-w-0"><h2 className="font-semibold">{item.name}</h2><p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm leading-6 text-muted">{item.body}</p></div><Button size="sm" className="ml-auto" onClick={() => setDraft(item)}><Pencil size={15} /></Button></div><Button size="sm" variant="danger" className="mt-4" onClick={() => confirm(`删除模板“${item.name}”？`) && remove.mutate(item.id)}><Trash2 size={15} />删除</Button></Card>)}</div> : <Empty title="没有模板" copy="把常用任务说明沉淀为模板。" />}
    <Dialog open={draft !== null} onOpenChange={open => !open && setDraft(null)} title={draft?.id ? "编辑模板" : "新建模板"}>{draft && <form className="grid gap-4" onSubmit={e => { e.preventDefault(); save.mutate(draft); }}><Field label="名称"><input className={inputClass} required value={draft.name || ""} onChange={e => setDraft({ ...draft, name: e.target.value })} /></Field><Field label="内容"><textarea className={inputClass + " min-h-48 py-3"} required value={draft.body || ""} onChange={e => setDraft({ ...draft, body: e.target.value })} /></Field><Field label="默认角色"><select className={inputClass} value={draft.role_id || ""} onChange={e => setDraft({ ...draft, role_id: e.target.value ? Number(e.target.value) : null })}><option value="">不预选</option>{roles.data?.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select></Field><div className="flex justify-end"><Button variant="primary">保存</Button></div></form>}</Dialog>
  </>;
}

export function SettingsPage() {
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api<Record<string, string>>("/settings") });
  const toast = useToast();
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const values = draft || settings.data || {};
  const save = useMutation({ mutationFn: () => api<Record<string, string>>("/settings", { method: "PUT", body: values }), onSuccess: data => { setDraft(data); toast("设置已保存"); } });
  if (settings.isLoading) return <Spinner />;
  return <><PageHeader kicker="Platform policy" title="设置" copy="设置即时写入平台配置；敏感凭据仍通过服务端环境变量提供。" actions={<Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending}><Save size={16} />保存</Button>} /><Card><div className="grid gap-5 md:grid-cols-2">{Object.entries(values).map(([key, value]) => <Field key={key} label={key}><input className={inputClass} value={value} onChange={e => setDraft({ ...values, [key]: e.target.value })} /></Field>)}</div>{!Object.keys(values).length && <Empty title="没有可编辑设置" copy="当前实例使用内置默认策略。" />}</Card></>;
}
