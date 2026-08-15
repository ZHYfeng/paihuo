import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, CirclePlus, Copy, FolderSearch, Pencil, Save, Trash2, X } from "lucide-react";
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
  const [view, setView] = useState<"grid" | "list">("grid");
  const [tab, setTab] = useState<"skills" | "extensions">("skills");
  const [detail, setDetail] = useState<(Skill & { content: string }) | null>(null);
  const [draftTags, setDraftTags] = useState<string[]>([]);
  const [scanSummary, setScanSummary] = useState("");
  const [extDialog, setExtDialog] = useState<"install" | "remove" | null>(null);
  const [extSource, setExtSource] = useState("");
  const [extName, setExtName] = useState("");
  const [extOutput, setExtOutput] = useState<ExtensionOutput | null>(null);
  const importOne = useMutation({ mutationFn: () => api<Skill>("/skills", { method: "POST", body: { source_path: path, tags: [] } }), onSuccess: () => { setPath(""); qc.invalidateQueries({ queryKey: keys.skills }); toast("已导入"); }, onError: (error: Error) => toast(error.message, "bad") });
  const scan = useMutation({ mutationFn: () => api<{ found: number; imported: Skill[]; skipped: string[]; errors: Array<{ source_path: string; error: string }> }>("/skills/scan", { method: "POST", body: { source_path: path, tags: [] } }), onSuccess: result => {
    qc.invalidateQueries({ queryKey: keys.skills });
    const imported = (result.imported || []).length;
    const skipped = (result.skipped || []).length;
    const failed = (result.errors || []).length;
    let summary = `发现 ${result.found || 0} 个 skill，已导入 ${imported} 个`;
    if (skipped) summary += `，跳过已导入 ${skipped} 个`;
    if (failed) summary += `，失败 ${failed} 个`;
    setScanSummary(summary);
    toast(summary, failed > 0 ? "bad" : "good");
  }, onError: (error: Error) => { setScanSummary(""); toast(error.message, "bad"); } });
  const remove = useMutation({ mutationFn: (id: number) => api(`/skills/${id}`, { method: "DELETE" }), onSuccess: (_, id) => { setSelected(prev => { const next = new Set(prev); next.delete(id); return next; }); qc.invalidateQueries({ queryKey: keys.skills }); toast("已删除"); }, onError: (error: Error) => toast(error.message, "bad") });
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
  const copyContent = async (skill: Skill) => {
    try {
      const full = await api<Skill & { content: string }>(`/skills/${skill.id}`);
      await navigator.clipboard.writeText(full.content);
      toast(`已复制 ${skill.name} 的 SKILL.md`);
    } catch (error) {
      toast((error as Error).message, "bad");
    }
  };

  return <>
    <PageHeader title="技能" copy="导入带 SKILL.md 的目录；角色只保存技能选择，执行时由平台物化挂载。" />
    <div className="mb-4 flex gap-1 rounded-xl border border-line bg-surface p-1">
      <button className={cn("flex-1 rounded-lg px-4 py-2 text-sm font-medium transition-all", tab === "skills" ? "bg-brand text-white" : "text-muted hover:bg-hover hover:text-ink")} onClick={() => setTab("skills")}>技能库</button>
      <button className={cn("flex-1 rounded-lg px-4 py-2 text-sm font-medium transition-all", tab === "extensions" ? "bg-brand text-white" : "text-muted hover:bg-hover hover:text-ink")} onClick={() => setTab("extensions")}>Pi 扩展</button>
    </div>
    {tab === "skills" && <>
      <Card className="mb-4"><form className="flex flex-col gap-3 sm:flex-row" onSubmit={e => { e.preventDefault(); importOne.mutate(); }}><input className={inputClass} required placeholder="技能目录绝对路径" value={path} onChange={e => setPath(e.target.value)} /><Button variant="primary"><CirclePlus size={16} />导入</Button><Button type="button" onClick={() => scan.mutate()}><FolderSearch size={16} />递归扫描</Button></form>{(importOne.error || scan.error) instanceof Error && <p className="mt-3 text-sm text-danger">{(importOne.error || scan.error as Error).message}</p>}
        {scanSummary ? <p className="mt-3 rounded-xl border border-success/25 bg-success/10 px-3 py-2 text-sm text-success">{scanSummary}</p> : null}</Card>
      <Card className="mb-4 grid gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input className={inputClass + " sm:flex-1"} placeholder="搜索技能名称或说明…" value={search} onChange={e => setSearch(e.target.value)} />
          {skills.data?.length ? <div className="flex shrink-0 rounded-xl border border-line bg-elevated p-0.5" role="tablist" aria-label="视图切换">
            <button role="tab" aria-selected={view === "grid"} className={cn("rounded-[10px] px-2.5 py-1 text-[13px]", view === "grid" ? "bg-surface font-semibold text-ink shadow-sm" : "text-muted")} onClick={() => setView("grid")}>卡片</button>
            <button role="tab" aria-selected={view === "list"} className={cn("rounded-[10px] px-2.5 py-1 text-[13px]", view === "list" ? "bg-surface font-semibold text-ink shadow-sm" : "text-muted")} onClick={() => setView("list")}>列表</button>
          </div> : null}
        </div>
        {allTags.length > 0 && <div className="flex flex-wrap gap-2">{allTags.map(tag => <button key={tag} type="button" className={cn("rounded-full border px-2.5 py-1 text-xs font-medium transition-colors", tagFilter.has(tag) ? "border-brand bg-brand/10 text-brand-soft" : "border-line bg-elevated text-muted hover:bg-hover")} onClick={() => toggleTag(tag)}>{tag}</button>)}</div>}
      </Card>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="text-sm text-muted">{filtered.length === skills.data?.length ? `${skills.data.length} 个技能` : `${filtered.length} / ${skills.data?.length} 个技能`} · 已选 {selected.size} 项</span>
        <Button variant="danger" size="sm" disabled={selected.size === 0} onClick={() => confirm(`删除选中的 ${selected.size} 个技能？`) && removeMany.mutate(Array.from(selected))}><Trash2 size={15} />删除选中</Button>
      </div>
      {skills.isLoading ? <Spinner /> : skills.data?.length === 0 ? <Empty title="技能库为空" copy="从一个包含 SKILL.md 的目录开始导入。" /> : filtered.length === 0 ? <Empty title="没有匹配的技能" copy="调整搜索或标签筛选后重试。" /> : view === "grid" ? Array.from(groups.entries()).map(([dir, list]) => (
        <div key={dir} className="mb-6">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-ink"><input type="checkbox" className="size-4" checked={list.every(skill => selected.has(skill.id))} onChange={() => toggleGroup(list)} />来源目录 <code className="font-mono text-xs font-normal text-muted">{dir}</code></label>
            <span className="text-xs text-muted">{list.length} 个</span>
          </div>
          <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">{list.map(skill => (
            <Card key={skill.id}>
              <div className="flex items-start gap-3">
                <button className="min-w-0 text-left" onClick={() => openDetail(skill)}><h2 className="font-semibold hover:text-brand-soft">{skill.name}</h2><p className="mt-2 text-sm leading-5 text-muted">{skill.description || "暂无说明"}</p></button>
                <div className="ml-auto flex items-center gap-1"><input type="checkbox" className="size-4" aria-label={`选择 ${skill.name}`} checked={selected.has(skill.id)} onChange={() => toggleSkill(skill.id)} /><Button variant="danger" size="sm" aria-label={`删除 ${skill.name}`} onClick={() => confirm(`删除 skill「${skill.name}」？将同时移除工作目录中的副本，已引用它的角色配置会失效。`) && remove.mutate(skill.id)}><Trash2 size={15} /></Button></div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">{skill.tags?.length ? skill.tags.map(tag => <Badge key={tag}>{tag}</Badge>) : <Badge>未分类</Badge>}<Button size="sm" variant="ghost" className="ml-auto" onClick={() => void copyContent(skill)}><Copy size={13} />复制 SKILL.md</Button></div>
            </Card>
          ))}</div>
        </div>
      )) : <Card className="overflow-x-auto p-0"><table className="w-full text-sm"><thead><tr className="border-b border-line text-left text-xs text-faint">
        <th className="w-10 px-3 py-2 font-medium"><input type="checkbox" className="size-4" aria-label="全选技能" checked={filtered.length > 0 && filtered.every(skill => selected.has(skill.id))} onChange={() => toggleGroup(filtered)} /></th>
        <th className="whitespace-nowrap px-3 py-2 font-medium">技能</th><th className="whitespace-nowrap px-3 py-2 font-medium">标签</th><th className="whitespace-nowrap px-3 py-2 font-medium">来源目录</th><th className="whitespace-nowrap px-3 py-2 font-medium">添加时间</th><th className="whitespace-nowrap px-3 py-2 font-medium">操作</th>
      </tr></thead><tbody className="divide-y divide-line">{filtered.map(skill => <tr key={skill.id} className="hover:bg-hover">
        <td className="px-3 py-2"><input type="checkbox" className="size-4" aria-label={`选择 ${skill.name}`} checked={selected.has(skill.id)} onChange={() => toggleSkill(skill.id)} /></td>
        <td className="whitespace-nowrap px-3 py-2 font-medium"><button className="hover:text-brand-soft" onClick={() => openDetail(skill)}>{skill.name}</button><div className="mt-0.5 max-w-80 truncate text-xs text-faint">{skill.description || ""}</div></td>
        <td className="px-3 py-2"><span className="inline-flex flex-wrap gap-1">{skill.tags?.length ? skill.tags.map(tag => <Badge key={tag}>{tag}</Badge>) : <Badge>未分类</Badge>}</span></td>
        <td className="max-w-52 truncate px-3 py-2 font-mono text-xs text-muted" title={skill.dir}>{skill.dir}</td>
        <td className="px-3 py-2 text-faint">{formatTime(skill.created_at)}</td>
        <td className="px-3 py-2"><span className="inline-flex gap-1.5"><Button size="sm" variant="ghost" onClick={() => void copyContent(skill)}><Copy size={13} />复制</Button><Button size="sm" variant="danger" onClick={() => confirm(`删除 skill「${skill.name}」？`) && remove.mutate(skill.id)}><Trash2 size={13} /></Button></span></td>
      </tr>)}</tbody></table></Card>}
    </>}
    {tab === "extensions" && <>
      <div className="mb-4 flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => openExtDialog("install")}><CirclePlus size={16} />安装扩展</Button>
        <Button variant="danger" onClick={() => openExtDialog("remove")}><Trash2 size={16} />移除扩展</Button>
      </div>
      {extensions.isLoading ? <Spinner /> : <Card>{extensions.data?.error && <p className="mb-3 text-sm text-danger">{extensions.data.error}</p>}<pre className="whitespace-pre-wrap break-words rounded-xl border border-line bg-elevated p-3 font-mono text-xs leading-5 text-ink">{extensions.data?.raw || "（无输出）"}</pre></Card>}
    </>}
    <Dialog open={detail !== null} onOpenChange={open => !open && setDetail(null)} title={detail?.name || "技能详情"} wide>{detail && <>
      <div className="mb-4">
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
      {extOutput && <>{extOutput.error && <p className="text-sm text-danger">{extOutput.error}</p>}<pre className="whitespace-pre-wrap break-words rounded-xl border border-line bg-elevated p-3 font-mono text-xs leading-5 text-ink">{extOutput.raw || "（无输出）"}</pre></>}
      <div className="flex justify-end"><Button variant="primary" disabled={installExt.isPending}>{installExt.isPending ? "安装中…" : "安装"}</Button></div>
    </form>}</Dialog>
    <Dialog open={extDialog === "remove"} onOpenChange={open => !open && setExtDialog(null)} title="移除 Pi 扩展" description="按扩展名移除，卸载后技能列表会同步刷新。">{extDialog === "remove" && <form className="grid gap-4" onSubmit={e => { e.preventDefault(); removeExt.mutate(extName); }}>
      <Field label="扩展名"><input className={inputClass} required placeholder="扩展名称" value={extName} onChange={e => setExtName(e.target.value)} /></Field>
      {extOutput && <>{extOutput.error && <p className="text-sm text-danger">{extOutput.error}</p>}<pre className="whitespace-pre-wrap break-words rounded-xl border border-line bg-elevated p-3 font-mono text-xs leading-5 text-ink">{extOutput.raw || "（无输出）"}</pre></>}
      <div className="flex justify-end"><Button variant="danger" disabled={removeExt.isPending}>{removeExt.isPending ? "移除中…" : "移除"}</Button></div>
    </form>}</Dialog>
  </>;
}

type ScheduleDraft = Partial<Schedule>;

const WEEKDAYS = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const DEFAULT_TIME = "09:00";

// 调度器仍以 cron 保存规则，但只把常用的周期映射到表单。兼容旧版五段与六段 cron。
function parseScheduleCron(cron: string): { frequency: string; weekday?: string; monthday?: string; time?: string } | null {
  const raw = String(cron || "").trim().toLowerCase();
  if (raw === "@daily") return { frequency: "daily", time: "00:00" };
  if (raw === "@weekly") return { frequency: "weekly", weekday: "7", time: "00:00" };
  if (raw === "@monthly") return { frequency: "monthly", monthday: "1", time: "00:00" };
  const fields = raw.split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) return null;
  const [second, minute, hour, dom, month, dow] = fields.length === 6 ? fields : ["0", fields[0], fields[1], fields[2], fields[3], fields[4]];
  if (second !== "0" || month !== "*") return null;
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return null;
  const minuteNum = Number(minute), hourNum = Number(hour);
  if (minuteNum < 0 || minuteNum > 59 || hourNum < 0 || hourNum > 23) return null;
  const time = `${String(hourNum).padStart(2, "0")}:${String(minuteNum).padStart(2, "0")}`;
  if (dom === "*" && dow === "*") return { frequency: "daily", time };
  if (dom === "*" && dow === "1-5") return { frequency: "weekdays", time };
  if (dom === "*" && /^\d$/.test(dow) && Number(dow) >= 0 && Number(dow) <= 7) {
    return { frequency: "weekly", weekday: String(Number(dow) === 0 ? 7 : Number(dow)), time };
  }
  if (dow === "*" && /^\d{1,2}$/.test(dom) && Number(dom) >= 1 && Number(dom) <= 31) {
    return { frequency: "monthly", monthday: String(Number(dom)), time };
  }
  return null;
}

function scheduleLabel(cron: string): string {
  const parsed = parseScheduleCron(cron);
  if (!parsed) return "自定义周期";
  if (parsed.frequency === "daily") return `每天 ${parsed.time}`;
  if (parsed.frequency === "weekdays") return `工作日 ${parsed.time}`;
  if (parsed.frequency === "weekly") return `每周${WEEKDAYS[Number(parsed.weekday)] || ""} ${parsed.time}`;
  if (parsed.frequency === "monthly") return `每月${parsed.monthday}日 ${parsed.time}`;
  return "自定义周期";
}

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

export function SchedulesPage() {
  const schedules = useQuery({ queryKey: ["schedules"], queryFn: () => api<Schedule[]>("/schedules") });
  const roles = useQuery({ queryKey: keys.roles, queryFn: () => api<Role[]>("/roles") });
  const projects = useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/projects") });
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const [frequency, setFrequency] = useState("daily");
  const [weekday, setWeekday] = useState("1");
  const [monthday, setMonthday] = useState("1");
  const [time, setTime] = useState(DEFAULT_TIME);
  const [unsupported, setUnsupported] = useState(false);
  const [dirty, setDirty] = useState(false);
  const save = useMutation({
    mutationFn: (value: ScheduleDraft) => {
      const cron = unsupported && !dirty ? value.cron : cronFromFields(frequency, weekday, monthday, time);
      if (!cron) throw new Error("请选择有效的执行时间");
      const body = { ...schedulePayload(value), cron };
      return value.id ? api(`/schedules/${value.id}`, { method: "PATCH", revision: value.revision, body }) : api("/schedules", { method: "POST", body });
    },
    onSuccess: () => { setDraft(null); qc.invalidateQueries({ queryKey: ["schedules"] }); toast("已保存"); },
    onError: error => toast((error as Error).message, "bad")
  });
  const remove = useMutation({ mutationFn: (value: Schedule) => api(`/schedules/${value.id}`, { method: "DELETE", revision: value.revision }), onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }) });
  const toggle = useMutation({
    mutationFn: (value: Schedule) => api(`/schedules/${value.id}`, { method: "PATCH", revision: value.revision, body: { enabled: !value.enabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }),
    onError: error => toast((error as Error).message, "bad")
  });
  const openEditor = (item: Schedule | null) => {
    setDraft(item ? { ...item } : { perm: "full", enabled: true, block_on_failure: true });
    if (item) {
      const parsed = parseScheduleCron(item.cron);
      setUnsupported(!parsed);
      setDirty(false);
      setFrequency(parsed?.frequency || "daily");
      setWeekday(parsed?.weekday || "1");
      setMonthday(parsed?.monthday || "1");
      setTime(parsed?.time || DEFAULT_TIME);
    } else {
      setUnsupported(false);
      setDirty(false);
      setFrequency("daily");
      setWeekday("1");
      setMonthday("1");
      setTime(DEFAULT_TIME);
    }
  };
  const preview = unsupported && !dirty ? "当前任务使用了自定义周期；调整上面的选项后会转换为常用周期。" : `将按“${scheduleLabel(cronFromFields(frequency, weekday, monthday, time))}”执行`;
  return <>
    <PageHeader title="定时任务" copy="按 cron 创建普通任务，后续仍遵守同一依赖、权限和并发策略。" actions={<Button variant="primary" onClick={() => openEditor(null)}><CalendarPlus size={16} />新建定时任务</Button>} />
    {schedules.isLoading ? <Spinner /> : schedules.data?.length ? <Card className="overflow-x-auto p-0"><table className="w-full text-sm"><thead><tr className="border-b border-line text-left text-xs text-faint">
      <th className="whitespace-nowrap px-3 py-2 font-medium">名称</th><th className="whitespace-nowrap px-3 py-2 font-medium">周期</th><th className="whitespace-nowrap px-3 py-2 font-medium">角色</th><th className="whitespace-nowrap px-3 py-2 font-medium">类型</th><th className="whitespace-nowrap px-3 py-2 font-medium">任务标题</th><th className="whitespace-nowrap px-3 py-2 font-medium">上次执行</th><th className="whitespace-nowrap px-3 py-2 font-medium">启用</th><th className="whitespace-nowrap px-3 py-2 font-medium">操作</th>
    </tr></thead><tbody className="divide-y divide-line">{schedules.data.map(item => <tr key={item.id} className="hover:bg-hover">
      <td className="whitespace-nowrap px-3 py-2 font-medium">{item.name}</td>
      <td className="px-3 py-2"><span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-elevated px-2.5 py-1 text-xs text-muted">{scheduleLabel(item.cron)}</span><code className="ml-1 text-[11px] text-faint">{item.cron}</code></td>
      <td className="whitespace-nowrap px-3 py-2 text-muted">{item.role_name || "-"}</td>
      <td className="px-3 py-2">{item.project_id ? <><span className="chip">项目 · {item.project_name || `#${item.project_id}`}</span>{item.block_on_failure ? <span className="chip merge-blocked">失败阻塞</span> : null}</> : <span className="chip">通用</span>}</td>
      <td className="max-w-52 truncate px-3 py-2 text-muted" title={item.title_template}>{item.title_template || "-"}</td>
      <td className="px-3 py-2 text-faint">{String(item.last_run_at || "-").slice(0, 16).replace("T", " ")}</td>
      <td className="px-3 py-2"><label className="sw" title={item.enabled ? "停用" : "启用"}><input type="checkbox" checked={item.enabled} onChange={() => toggle.mutate(item)} /><span className="sw-slider" /></label></td>
      <td className="px-3 py-2"><span className="inline-flex gap-1.5"><Button size="sm" variant="ghost" onClick={() => openEditor(item)}><Pencil size={14} />编辑</Button><Button size="sm" variant="danger" aria-label={`删除 ${item.name}`} onClick={() => confirm(`删除“${item.name}”？`) && remove.mutate(item)}><Trash2 size={14} /></Button></span></td>
    </tr>)}</tbody></table></Card> : <Empty title="没有定时任务" copy="为周期性检查、同步或报告创建一条 cron 规则。" />}
    <Dialog open={draft !== null} onOpenChange={open => !open && setDraft(null)} title={draft?.id ? "编辑定时任务" : "新建定时任务"} wide>{draft && <form className="grid gap-4" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(draft); }}>
      <div className="grid gap-4 md:grid-cols-2"><Field label="名称"><input className={inputClass} required value={draft.name || ""} onChange={e => setDraft({ ...draft, name: e.target.value })} /></Field><Field label="任务标题"><input className={inputClass} required value={draft.title_template || ""} onChange={e => setDraft({ ...draft, title_template: e.target.value })} /></Field></div>
      <Field label="任务说明"><textarea className={inputClass + " min-h-28 py-3"} value={draft.body_template || ""} onChange={e => setDraft({ ...draft, body_template: e.target.value })} /></Field>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="周期"><select className={inputClass} value={frequency} onChange={e => { setDirty(true); setFrequency(e.target.value); }}><option value="daily">每天</option><option value="weekdays">工作日</option><option value="weekly">每周</option><option value="monthly">每月</option></select></Field>
        <Field label="时间"><input type="time" className={inputClass} value={time} onChange={e => { setDirty(true); setTime(e.target.value); }} /></Field>
      </div>
      {frequency === "weekly" ? <Field label="星期"><select className={inputClass} value={weekday} onChange={e => { setDirty(true); setWeekday(e.target.value); }}>{WEEKDAYS.slice(1).map((label, index) => <option key={index + 1} value={index + 1}>{label}</option>)}</select></Field> : frequency === "monthly" ? <Field label="日期"><select className={inputClass} value={monthday} onChange={e => { setDirty(true); setMonthday(e.target.value); }}>{Array.from({ length: 31 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1} 日</option>)}</select></Field> : null}
      <p className={cn("rounded-xl px-3 py-2 text-sm", unsupported && !dirty ? "bg-warning/10 text-warning" : "bg-elevated text-muted")}>{preview}</p>
      <div className="grid gap-4 md:grid-cols-2"><Field label="角色"><select className={inputClass} required value={draft.role_id || ""} onChange={e => setDraft({ ...draft, role_id: Number(e.target.value) })}><option value="">请选择</option>{roles.data?.filter(r => r.enabled).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field><Field label="项目"><select className={inputClass} value={draft.project_id || ""} onChange={e => setDraft({ ...draft, project_id: e.target.value ? Number(e.target.value) : null })}><option value="">不绑定项目</option>{projects.data?.filter(p => p.status === "active").map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field></div>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="权限"><select className={inputClass} value={draft.perm || "full"} onChange={e => setDraft({ ...draft, perm: e.target.value as "full" | "review" })}><option value="full">自动整合</option><option value="review">人工审批</option></select></Field>
        <label className="flex min-h-11 items-center gap-3 self-end rounded-xl border border-line bg-elevated px-3 text-sm"><input type="checkbox" checked={draft.block_on_failure ?? true} onChange={e => setDraft({ ...draft, block_on_failure: e.target.checked })} />失败后阻塞后续任务</label>
      </div>
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
  return <><PageHeader title="模板" copy="维护可复用的任务说明，并可预选执行角色。" actions={<Button variant="primary" onClick={() => setDraft({})}><CirclePlus size={16} />新建模板</Button>} />
    {templates.isLoading ? <Spinner /> : templates.data?.length ? <Card className="overflow-x-auto p-0"><table className="w-full text-sm"><thead><tr className="border-b border-line text-left text-xs text-faint"><th className="whitespace-nowrap px-3 py-2 font-medium">名称</th><th className="whitespace-nowrap px-3 py-2 font-medium">角色</th><th className="whitespace-nowrap px-3 py-2 font-medium">内容</th><th className="whitespace-nowrap px-3 py-2 font-medium">操作</th></tr></thead><tbody className="divide-y divide-line">{templates.data.map(item => <tr key={item.id} className="hover:bg-hover"><td className="whitespace-nowrap px-3 py-2 font-medium">{item.name}</td><td className="px-3 py-2">{item.role_name ? <Badge tone="info">{item.role_name}</Badge> : <span className="whitespace-nowrap text-faint">不预选</span>}</td><td className="max-w-96 truncate px-3 py-2 text-muted" title={item.body}>{item.body}</td><td className="px-3 py-2"><span className="inline-flex gap-1.5"><Button size="sm" variant="ghost" onClick={() => setDraft(item)}><Pencil size={14} />编辑</Button><Button size="sm" variant="danger" aria-label={`删除模板 ${item.name}`} onClick={() => confirm(`删除模板“${item.name}”？`) && remove.mutate(item.id)}><Trash2 size={14} /></Button></span></td></tr>)}</tbody></table></Card> : <Empty title="没有模板" copy="把常用任务说明沉淀为模板。" />}
    <Dialog open={draft !== null} onOpenChange={open => !open && setDraft(null)} title={draft?.id ? "编辑模板" : "新建模板"}>{draft && <form className="grid gap-4" onSubmit={e => { e.preventDefault(); save.mutate(draft); }}><Field label="名称"><input className={inputClass} required value={draft.name || ""} onChange={e => setDraft({ ...draft, name: e.target.value })} /></Field><Field label="内容"><textarea className={inputClass + " min-h-48 py-3"} required value={draft.body || ""} onChange={e => setDraft({ ...draft, body: e.target.value })} /></Field><Field label="默认角色"><select className={inputClass} value={draft.role_id || ""} onChange={e => setDraft({ ...draft, role_id: e.target.value ? Number(e.target.value) : null })}><option value="">不预选</option>{roles.data?.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select></Field><div className="flex justify-end"><Button variant="primary">保存</Button></div></form>}</Dialog>
  </>;
}

export function SettingsPage() {
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api<Record<string, string>>("/settings") });
  const roles = useQuery({ queryKey: keys.roles, queryFn: () => api<Role[]>("/roles") });
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [cleanupRole, setCleanupRole] = useState("");
  const [cleanupDays, setCleanupDays] = useState("");
  const [retention, setRetention] = useState("");
  const [wtRetention, setWtRetention] = useState("");
  const values = draft || settings.data || {};
  const save = useMutation({
    mutationFn: () => api<Record<string, string>>("/settings", { method: "PUT", body: values }),
    onSuccess: data => { setDraft(data); setRetention(data.retention_days || ""); setWtRetention(data.worktree_retention_days || ""); toast("设置已保存"); },
    onError: error => toast((error as Error).message, "bad")
  });
  const saveKey = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) => api<Record<string, string>>("/settings", { method: "PUT", body: { ...values, [key]: value } }),
    onSuccess: (data, input) => { setDraft(data); qc.invalidateQueries({ queryKey: ["settings"] }); toast(input.key === "retention_days" ? "已保存，每小时执行一次自动清理" : "已保存，每小时自动清理一次"); },
    onError: error => toast((error as Error).message, "bad")
  });
  const cleanup = useMutation({
    mutationFn: () => api<{ deleted: number }>("/tasks/cleanup", { method: "POST", body: { role_id: cleanupRole ? Number(cleanupRole) : null, before: cleanupDays ? new Date(Date.now() - Number(cleanupDays) * 86400_000).toISOString() : "" } }),
    onSuccess: data => { toast(`已删除 ${data.deleted} 条历史`); qc.invalidateQueries({ queryKey: keys.tasks }); qc.invalidateQueries({ queryKey: keys.stats }); },
    onError: error => toast((error as Error).message, "bad")
  });
  if (settings.isLoading) return <Spinner />;
  const effectiveRetention = retention || values.retention_days || "";
  const effectiveWt = wtRetention || values.worktree_retention_days || "";
  return <><PageHeader title="设置" copy="设置即时写入平台配置；敏感凭据仍通过服务端环境变量提供。" actions={<Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending}><Save size={16} />保存</Button>} />
    <div className="grid gap-3">
      <Card><div className="mb-1 flex items-center"><h2 className="font-semibold">保留与清理</h2></div>
        <div className="grid gap-4">
          <div className="set-row grid grid-cols-1 items-center gap-4 rounded-xl border border-line bg-elevated px-4 py-3 md:grid-cols-[minmax(0,1fr)_auto]"><div><div className="text-sm font-semibold">任务保留期限</div><div className="mt-0.5 text-xs text-muted">终态任务在数据库保留的天数，超过后由每小时自动清理回收。</div></div><div className="flex items-center gap-2"><input type="number" min={1} className={inputClass + " w-24"} value={effectiveRetention} placeholder="天数" aria-label="任务保留天数" onChange={e => setRetention(e.target.value)} /><Button size="sm" disabled={saveKey.isPending} onClick={() => saveKey.mutate({ key: "retention_days", value: effectiveRetention })}>保存</Button></div></div>
          <div className="set-row grid grid-cols-1 items-center gap-4 rounded-xl border border-line bg-elevated px-4 py-3 md:grid-cols-[minmax(0,1fr)_auto]"><div><div className="text-sm font-semibold">工作空间保留期限</div><div className="mt-0.5 text-xs text-muted">已结算任务的 worktree 在磁盘保留的天数，超过后自动清理。</div></div><div className="flex items-center gap-2"><input type="number" min={1} className={inputClass + " w-24"} value={effectiveWt} placeholder="天数" aria-label="工作空间保留天数" onChange={e => setWtRetention(e.target.value)} /><Button size="sm" disabled={saveKey.isPending} onClick={() => saveKey.mutate({ key: "worktree_retention_days", value: effectiveWt })}>保存</Button></div></div>
        </div>
      </Card>
      <Card><h2 className="font-semibold">手动清理</h2><p className="mt-1 text-sm text-muted">按角色与时间删除终态任务及其 worktree、分支与合并子任务。</p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field label="角色"><select className={inputClass + " sm:w-48"} value={cleanupRole} onChange={e => setCleanupRole(e.target.value)}><option value="">全部角色</option>{roles.data?.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select></Field>
          <Field label="删除早于（天）"><input type="number" min={1} className={inputClass + " sm:w-36"} value={cleanupDays} onChange={e => setCleanupDays(e.target.value)} placeholder="不限时间" /></Field>
          <Button variant="danger" disabled={cleanup.isPending} onClick={() => { if (confirm(`删除${cleanupRole ? "该角色" : "全部角色"}${cleanupDays ? "、" + cleanupDays + " 天前" : ""}的终态任务？不可恢复！`)) cleanup.mutate(); }}><Trash2 size={15} />执行清理</Button>
        </div>
        {cleanup.error instanceof Error && <p className="mt-3 text-sm text-danger">{cleanup.error.message}</p>}
      </Card>
      <Card><div className="grid gap-4 md:grid-cols-2">{Object.entries(values).filter(([key]) => key !== "retention_days" && key !== "worktree_retention_days").map(([key, value]) => <Field key={key} label={key}><input className={inputClass} value={value} onChange={e => setDraft({ ...values, [key]: e.target.value })} /></Field>)}</div>{!Object.keys(values).length && <Empty title="没有可编辑设置" copy="当前实例使用内置默认策略。" />}</Card>
    </div>
  </>;
}

function formatTime(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
