import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, CirclePlus, FolderSearch, Pencil, Save, Trash2, X } from "lucide-react";
import { FormEvent, useState } from "react";
import { Markdown } from "../components/markdown";
import { PageHeader } from "../components/shell";
import { Badge, Button, Card, cn, Dialog, Empty, Field, inputClass, Spinner, useToast } from "../components/ui";
import { api, keys } from "../lib/api";
import type { ExtensionOutput, Project, Role, Schedule, Skill, TaskTemplate } from "../types";

export function SkillsPage() {
  const skills = useQuery({ queryKey: keys.skills, queryFn: () => api<Skill[]>("/skills") });
  const extensions = useQuery({ queryKey: ["extensions"], queryFn: () => api<ExtensionOutput>("/extensions") });
  const qc = useQueryClient();
  const toast = useToast();
  const [path, setPath] = useState("");
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [tab, setTab] = useState<"skills" | "extensions">("skills");
  const [detail, setDetail] = useState<(Skill & { content: string }) | null>(null);
  const [draftTags, setDraftTags] = useState<string[]>([]);
  const [extDialog, setExtDialog] = useState<"install" | "remove" | null>(null);
  const [extSource, setExtSource] = useState("");
  const [extName, setExtName] = useState("");
  const [extOutput, setExtOutput] = useState<ExtensionOutput | null>(null);
  const importOne = useMutation({ mutationFn: () => api<Skill>("/skills", { method: "POST", body: { source_path: path, tags: [] } }), onSuccess: () => { setPath(""); qc.invalidateQueries({ queryKey: keys.skills }); } });
  const scan = useMutation({ mutationFn: () => api("/skills/scan", { method: "POST", body: { source_path: path, tags: [] } }), onSuccess: () => qc.invalidateQueries({ queryKey: keys.skills }) });
  const remove = useMutation({ mutationFn: (id: number) => api(`/skills/${id}`, { method: "DELETE" }), onSuccess: (_, id) => { setSelected(prev => { const next = new Set(prev); next.delete(id); return next; }); qc.invalidateQueries({ queryKey: keys.skills }); }, onError: (error: Error) => toast(error.message, "bad") });
  const removeMany = useMutation({ mutationFn: (ids: number[]) => api("/skills", { method: "DELETE", body: { ids } }), onSuccess: (_, ids) => { toast(`已删除 ${ids.length} 个技能`); setSelected(new Set()); qc.invalidateQueries({ queryKey: keys.skills }); }, onError: (error: Error) => toast(error.message, "bad") });
  const saveTags = useMutation({ mutationFn: ({ id, tags }: { id: number; tags: string[] }) => api(`/skills/${id}`, { method: "PATCH", body: { tags } }), onSuccess: () => { toast("标签已保存"); qc.invalidateQueries({ queryKey: keys.skills }); }, onError: (error: Error) => toast(error.message, "bad") });
  const installExt = useMutation({ mutationFn: (source: string) => api<ExtensionOutput>("/extensions/install", { method: "POST", body: { source } }), onSuccess: data => { setExtOutput(data); toast("扩展已安装"); qc.invalidateQueries({ queryKey: ["extensions"] }); }, onError: (error: Error) => { setExtOutput({ raw: "", error: error.message }); toast(error.message, "bad"); } });
  const removeExt = useMutation({ mutationFn: (name: string) => api<ExtensionOutput>(`/extensions/${name}`, { method: "DELETE" }), onSuccess: data => { setExtOutput(data); toast("扩展已移除"); qc.invalidateQueries({ queryKey: ["extensions"] }); }, onError: (error: Error) => { setExtOutput({ raw: "", error: error.message }); toast(error.message, "bad"); } });

  const allTags = Array.from(new Set((skills.data ?? []).flatMap(skill => skill.tags ?? []))).sort();
  const filtered = (skills.data ?? []).filter(skill => {
    const q = search.trim().toLowerCase();
    const hit = !q || skill.name.toLowerCase().includes(q) || (skill.description || "").toLowerCase().includes(q);
    const tagged = tagFilter.size === 0 || (skill.tags ?? []).some(tag => tagFilter.has(tag));
    return hit && tagged;
  });
  const groups = new Map<string, Skill[]>();
  for (const skill of filtered) {
    const dir = skill.dir || "未分类";
    const list = groups.get(dir);
    if (list) list.push(skill); else groups.set(dir, [skill]);
  }
  const toggleTag = (tag: string) => setTagFilter(prev => { const next = new Set(prev); if (next.has(tag)) next.delete(tag); else next.add(tag); return next; });
  const toggleSkill = (id: number) => setSelected(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const toggleGroup = (list: Skill[]) => setSelected(prev => {
    const next = new Set(prev);
    const all = list.every(skill => next.has(skill.id));
    list.forEach(skill => { if (all) next.delete(skill.id); else next.add(skill.id); });
    return next;
  });
  const openDetail = async (skill: Skill) => {
    const full = await api<Skill & { content: string }>(`/skills/${skill.id}`);
    setDraftTags(full.tags ?? []);
    setDetail(full);
  };
  const openExtDialog = (mode: "install" | "remove") => { setExtDialog(mode); setExtSource(""); setExtName(""); setExtOutput(null); };

  return <>
    <PageHeader kicker="Reusable capabilities" title="技能" copy="导入带 SKILL.md 的目录；角色只保存技能选择，执行时由平台物化挂载。" />
    <div className="mb-5 flex gap-1 rounded-xl border border-line bg-surface p-1">
      <button className={cn("flex-1 rounded-lg px-4 py-2 text-sm font-medium transition-colors", tab === "skills" ? "bg-brand text-white" : "text-muted hover:bg-hover hover:text-ink")} onClick={() => setTab("skills")}>技能库</button>
      <button className={cn("flex-1 rounded-lg px-4 py-2 text-sm font-medium transition-colors", tab === "extensions" ? "bg-brand text-white" : "text-muted hover:bg-hover hover:text-ink")} onClick={() => setTab("extensions")}>Pi 扩展</button>
    </div>
    {tab === "skills" && <>
      <Card className="mb-5"><form className="flex flex-col gap-3 sm:flex-row" onSubmit={e => { e.preventDefault(); importOne.mutate(); }}><input className={inputClass} required placeholder="技能目录绝对路径" value={path} onChange={e => setPath(e.target.value)} /><Button variant="primary"><CirclePlus size={16} />导入</Button><Button type="button" onClick={() => scan.mutate()}><FolderSearch size={16} />递归扫描</Button></form>{(importOne.error || scan.error) instanceof Error && <p className="mt-3 text-sm text-danger">{(importOne.error || scan.error as Error).message}</p>}</Card>
      <Card className="mb-5 grid gap-3">
        <input className={inputClass} placeholder="搜索技能名称或说明…" value={search} onChange={e => setSearch(e.target.value)} />
        {allTags.length > 0 && <div className="flex flex-wrap gap-2">{allTags.map(tag => <button key={tag} type="button" className={cn("rounded-full border px-2.5 py-1 text-xs font-medium transition-colors", tagFilter.has(tag) ? "border-brand bg-brand/10 text-brand-soft" : "border-line bg-elevated text-muted hover:bg-hover")} onClick={() => toggleTag(tag)}>{tag}</button>)}</div>}
      </Card>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <span className="text-sm text-muted">已选 {selected.size} 项</span>
        <Button variant="danger" size="sm" disabled={selected.size === 0} onClick={() => confirm(`删除选中的 ${selected.size} 个技能？`) && removeMany.mutate(Array.from(selected))}><Trash2 size={15} />删除选中</Button>
      </div>
      {skills.isLoading ? <Spinner /> : skills.data?.length === 0 ? <Empty title="技能库为空" copy="从一个包含 SKILL.md 的目录开始导入。" /> : filtered.length === 0 ? <Empty title="没有匹配的技能" copy="调整搜索或标签筛选后重试。" /> : Array.from(groups.entries()).map(([dir, list]) => (
        <div key={dir} className="mb-6">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-ink"><input type="checkbox" className="size-4" checked={list.every(skill => selected.has(skill.id))} onChange={() => toggleGroup(list)} />{dir}</label>
            <span className="text-xs text-muted">{list.length} 个</span>
          </div>
          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">{list.map(skill => (
            <Card key={skill.id}>
              <div className="flex items-start gap-3">
                <button className="min-w-0 text-left" onClick={() => openDetail(skill)}><h2 className="font-semibold hover:text-brand-soft">{skill.name}</h2><p className="mt-2 text-sm leading-5 text-muted">{skill.description || "暂无说明"}</p></button>
                <div className="ml-auto flex items-center gap-1"><input type="checkbox" className="size-4" aria-label={`选择 ${skill.name}`} checked={selected.has(skill.id)} onChange={() => toggleSkill(skill.id)} /><Button variant="danger" size="sm" aria-label={`删除 ${skill.name}`} onClick={() => confirm(`删除技能“${skill.name}”？`) && remove.mutate(skill.id)}><Trash2 size={15} /></Button></div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">{skill.tags?.map(tag => <Badge key={tag}>{tag}</Badge>)}</div>
            </Card>
          ))}</div>
        </div>
      ))}
    </>}
    {tab === "extensions" && <>
      <div className="mb-5 flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => openExtDialog("install")}><CirclePlus size={16} />安装扩展</Button>
        <Button variant="danger" onClick={() => openExtDialog("remove")}><Trash2 size={16} />移除扩展</Button>
      </div>
      {extensions.isLoading ? <Spinner /> : <Card>{extensions.data?.error && <p className="mb-3 text-sm text-danger">{extensions.data.error}</p>}<pre className="whitespace-pre-wrap break-words rounded-xl border border-line bg-elevated p-4 font-mono text-xs leading-5 text-ink">{extensions.data?.raw || "（无输出）"}</pre></Card>}
    </>}
    <Dialog open={detail !== null} onOpenChange={open => !open && setDetail(null)} title={detail?.name || "技能详情"} wide>{detail && <>
      <div className="mb-5">
        <div className="mb-2 text-sm font-medium">标签</div>
        <div className="flex flex-wrap gap-2">{draftTags.map(tag => <span key={tag} className="inline-flex items-center gap-1 rounded-full border border-line bg-elevated px-2.5 py-1 text-xs font-medium text-muted">{tag}<button type="button" className="text-faint hover:text-danger" aria-label={`移除标签 ${tag}`} onClick={() => setDraftTags(tags => tags.filter(t => t !== tag))}><X size={12} /></button></span>)}{draftTags.length === 0 && <span className="text-sm text-faint">暂无标签</span>}</div>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input className={inputClass} placeholder="输入标签后回车添加" onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); const tag = (e.target as HTMLInputElement).value.trim(); if (tag && !draftTags.includes(tag)) setDraftTags(tags => [...tags, tag]); (e.target as HTMLInputElement).value = ""; } }} />
          <Button variant="primary" disabled={saveTags.isPending} onClick={() => saveTags.mutate({ id: detail.id, tags: draftTags })}><Save size={15} />保存标签</Button>
        </div>
        {saveTags.error instanceof Error && <p className="mt-2 text-sm text-danger">{saveTags.error.message}</p>}
      </div>
      <Markdown>{detail.content}</Markdown>
    </>}</Dialog>
    <Dialog open={extDialog === "install"} onOpenChange={open => !open && setExtDialog(null)} title="安装 Pi 扩展" description="输入本地路径或包名，由 Pi 负责安装并挂载。">{extDialog === "install" && <form className="grid gap-4" onSubmit={e => { e.preventDefault(); installExt.mutate(extSource); }}>
      <Field label="来源（本地路径或包名）"><input className={inputClass} required placeholder="例如 /path/to/ext 或 some-package" value={extSource} onChange={e => setExtSource(e.target.value)} /></Field>
      {extOutput && <>{extOutput.error && <p className="text-sm text-danger">{extOutput.error}</p>}<pre className="whitespace-pre-wrap break-words rounded-xl border border-line bg-elevated p-4 font-mono text-xs leading-5 text-ink">{extOutput.raw || "（无输出）"}</pre></>}
      <div className="flex justify-end"><Button variant="primary" disabled={installExt.isPending}>{installExt.isPending ? "安装中…" : "安装"}</Button></div>
    </form>}</Dialog>
    <Dialog open={extDialog === "remove"} onOpenChange={open => !open && setExtDialog(null)} title="移除 Pi 扩展" description="按扩展名移除，卸载后技能列表会同步刷新。">{extDialog === "remove" && <form className="grid gap-4" onSubmit={e => { e.preventDefault(); removeExt.mutate(extName); }}>
      <Field label="扩展名"><input className={inputClass} required placeholder="扩展名称" value={extName} onChange={e => setExtName(e.target.value)} /></Field>
      {extOutput && <>{extOutput.error && <p className="text-sm text-danger">{extOutput.error}</p>}<pre className="whitespace-pre-wrap break-words rounded-xl border border-line bg-elevated p-4 font-mono text-xs leading-5 text-ink">{extOutput.raw || "（无输出）"}</pre></>}
      <div className="flex justify-end"><Button variant="danger" disabled={removeExt.isPending}>{removeExt.isPending ? "移除中…" : "移除"}</Button></div>
    </form>}</Dialog>
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
