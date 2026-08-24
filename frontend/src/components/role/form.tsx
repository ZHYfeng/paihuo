import { useState } from "react";
import { Field, inputClass } from "../ui";
import type { Role, RoleConfigDraft, RoleStudioDraft, RuntimeField, Skill } from "../../types";

export type RoleDraft = Omit<Partial<Role>, "role_config"> & { role_config: RoleConfigDraft };

/** 运行时字段分组渲染：
 *  - shorts（text/select）：两列并排，高度统一；
 *  - talls（textarea/list/额外参数）：两列并排，高度统一；
 *  - fulls（技能/扩展选择器、env）：独占一行。
 *
 * 避免把 36px 的输入框和 160px 的选择器放进同一网格行——CSS grid 会把
 * 整行撑到最高控件，短控件下方空一大片（留白）。
 */
export function RoleFieldGroups({ fields, draft, setDraft, skills }: { fields: RuntimeField[]; draft: RoleDraft; setDraft(draft: RoleDraft): void; skills?: Skill[] }) {
  if (!fields.length) return null;
  const shorts: RuntimeField[] = [];
  const talls: RuntimeField[] = [];
  const fulls: RuntimeField[] = [];
  for (const field of fields) {
    if (field.source === "skills" || field.source === "extensions" || field.type === "env") fulls.push(field);
    else if (field.type === "textarea" || field.type === "list" || field.key === "extra_args") talls.push(field);
    else shorts.push(field);
  }
  const render = (field: RuntimeField) => {
    const setRoleField = (value: unknown) => setDraft({ ...draft, role_config: field.builtin ? { ...draft.role_config, [field.key]: value } : { ...draft.role_config, custom: { ...draft.role_config.custom, [field.key]: String(value) } } });
    return field.source === "skills"
      ? <RoleSkillPicker key={field.key} skills={skills} value={field.builtin ? draft.role_config[field.key as keyof RoleConfigDraft] : draft.role_config.custom?.[field.key]} onChange={setRoleField} />
      : <RuntimeFieldInput key={field.key} field={resolveRuntimeField(field, draft.role_config, skills)} value={field.builtin ? draft.role_config[field.key as keyof RoleConfigDraft] : draft.role_config.custom?.[field.key]} onChange={setRoleField} />;
  };
  return <div className="grid gap-4">
    {shorts.length ? <div className="grid gap-4 md:grid-cols-2">{shorts.map(render)}</div> : null}
    {talls.length ? <div className="grid gap-4 md:grid-cols-2">{talls.map(render)}</div> : null}
    <div className="grid gap-4">{fulls.map(render)}</div>
  </div>;
}
export function statusLabelOf(status: string): string {
  const map: Record<string, string> = { queued: "排队", claimed: "领取", running: "执行中", awaiting_review: "待审批", succeeded: "完成", failed: "失败", cancelled: "取消" };
  return map[status] || status;
}

export function resolveRuntimeField(field: RuntimeField, config: RoleConfigDraft, skills?: Skill[]): RuntimeField {
  if (field.source === "skills") return { ...field, suggestions: skills?.map(skill => skill.dir) || [] };
  if (field.key === "thinking" && config.model && field.thinking_options_by_model?.[config.model]) {
    return { ...field, options: ["", ...field.thinking_options_by_model[config.model].filter(option => option !== "")] };
  }
  return field;
}

/** 角色技能选择器：按文件夹（分类）分组展示，支持搜索；标签 chip 点击
 *  一键选取/取消该标签的全部技能，分组头可全选。值与 RuntimeFieldInput
 *  的 skills 字段一致：技能目录数组（保持注册顺序）。 */
export function RoleSkillPicker({ skills, value, onChange }: { skills?: Skill[]; value: unknown; onChange(value: unknown): void }) {
  const [search, setSearch] = useState("");
  const all = skills || [];
  const selected = new Set<string>(Array.isArray(value) ? value : []);
  const categoryOf = (skill: Skill) => (skill.category || "").trim() || "未分类";
  const visible = all.filter(skill => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return skill.name.toLowerCase().includes(q) || (skill.description || "").toLowerCase().includes(q) || (skill.tags || []).some(tag => tag.toLowerCase().includes(q));
  });
  const commit = (next: Set<string>) => onChange(all.filter(skill => next.has(skill.dir)).map(skill => skill.dir));
  const toggle = (dir: string) => { const next = new Set(selected); if (next.has(dir)) next.delete(dir); else next.add(dir); commit(next); };
  const toggleGroup = (list: Skill[]) => { const next = new Set(selected); const allIn = list.length > 0 && list.every(skill => next.has(skill.dir)); list.forEach(skill => { if (allIn) next.delete(skill.dir); else next.add(skill.dir); }); commit(next); };
  const tagSkills = (tag: string) => all.filter(skill => (skill.tags || []).includes(tag));
  const toggleTag = (tag: string) => { const list = tagSkills(tag); const allIn = list.length > 0 && list.every(skill => selected.has(skill.dir)); const next = new Set(selected); list.forEach(skill => { if (allIn) next.delete(skill.dir); else next.add(skill.dir); }); commit(next); };
  const allTags = Array.from(new Set(all.flatMap(skill => skill.tags || []))).sort();
  const groups = new Map<string, Skill[]>();
  for (const skill of visible) { const key = categoryOf(skill); const list = groups.get(key); if (list) list.push(skill); else groups.set(key, [skill]); }
  const groupEntries = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return <fieldset className="grid gap-2 rounded-xl border border-line bg-elevated p-3">
    <legend className="px-1 text-sm font-medium text-ink">技能</legend>
    <input className={inputClass} placeholder="搜索技能名称、说明或标签…" value={search} onChange={e => setSearch(e.target.value)} />
    {allTags.length > 0 && <div className="flex flex-wrap gap-1.5">{allTags.map(tag => { const list = tagSkills(tag); const active = list.length > 0 && list.every(skill => selected.has(skill.dir)); return <button key={tag} type="button" title={active ? "取消该标签的全部技能" : "一键选取该标签的全部技能"} className={"rounded-full border px-2.5 py-1 text-xs font-medium transition-colors " + (active ? "border-brand bg-brand/10 text-brand-soft" : "border-line bg-surface text-muted hover:bg-hover")} onClick={() => toggleTag(tag)}>{tag}<span className={"ml-1 " + (active ? "text-brand-soft/70" : "text-faint")}>{list.filter(skill => selected.has(skill.dir)).length}/{list.length}</span></button>; })}</div>}
    {all.length === 0 ? <p className="text-sm leading-5 text-muted">技能库为空，请先到技能页导入。</p> : groupEntries.length === 0 ? <p className="text-sm leading-5 text-muted">没有匹配的技能。</p> : <div className="grid max-h-72 gap-2 overflow-auto pr-1">{groupEntries.map(([category, list]) => (
      <div key={category} className="grid gap-1">
        <div className="flex items-center gap-2 border-b border-line pb-1 text-xs font-semibold text-muted"><span>{category}</span><span className="font-normal text-faint">{list.filter(skill => selected.has(skill.dir)).length}/{list.length}</span><label className="ml-auto flex cursor-pointer items-center gap-1 font-normal select-none"><input type="checkbox" className="size-3.5 accent-brand" checked={list.length > 0 && list.every(skill => selected.has(skill.dir))} onChange={() => toggleGroup(list)} />全选</label></div>
        {list.map(skill => <label key={skill.dir} className="flex min-h-8 cursor-pointer items-center gap-2 text-xs font-normal text-ink"><input type="checkbox" className="accent-brand" checked={selected.has(skill.dir)} onChange={() => toggle(skill.dir)} /><span className="min-w-0 flex-1 truncate" title={skill.dir}>{skill.name}</span>{skill.tags?.length ? <span className="shrink-0 text-faint">{skill.tags.join("、")}</span> : null}</label>)}
      </div>
    ))}</div>}
  </fieldset>;
}

export function RuntimeFieldInput({ field, value, onChange }: { field: RuntimeField; value: unknown; onChange(value: unknown): void }) {
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
  if (field.type === "select") {
    const options = field.options || [];
    const allOptions = text && !options.includes(text) ? [text, ...options] : options;
    return <Field label={field.label} hint={field.help}><select className={inputClass} value={text} onChange={e => onChange(e.target.value)}><option value="">使用智能体默认值</option>{allOptions.map(option => <option key={option} value={option}>{option}</option>)}</select></Field>;
  }
  return <Field label={field.label} hint={field.help}><input className={inputClass} list={`runtime-${field.key}`} placeholder={field.placeholder} value={text} onChange={e => onChange(e.target.value)} />{field.suggestions?.length ? <datalist id={`runtime-${field.key}`}>{field.suggestions.map(option => <option key={option} value={option} />)}</datalist> : null}</Field>;
}

export function rolePayload(value: RoleDraft) {
  return { name: value.name, description: value.description || "", runtime_id: value.runtime_id, role_config: value.role_config, max_concurrency: value.max_concurrency || 1, delegation_enabled: value.delegation_enabled ?? false, delegation_max_perm: value.delegation_max_perm === "full" ? "full" : "review", enabled: value.enabled ?? true };
}

/** 编排委托：开关 + 子任务最大权限。声明后该角色的会话可派生真实子任务。 */
export function DelegationFields({ draft, setDraft }: { draft: RoleDraft | RoleStudioDraft; setDraft(draft: any): void }) {
  const on = Boolean(draft.delegation_enabled);
  return <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-elevated px-3 py-3">
    <label className="flex min-h-11 flex-1 items-center gap-3 text-sm">
      <input type="checkbox" checked={on} onChange={e => setDraft({ ...draft, delegation_enabled: e.target.checked })} />
      <span>
        <span className="block font-medium">编排委托（delegation）</span>
        <span className="block text-xs text-muted">开：该角色的会话可以把大任务拆成真实子任务（失败/危险活仍受人工审批）</span>
      </span>
    </label>
    {on && <label className="flex items-center gap-2 text-sm"><span className="text-muted">子任务最大权限</span>
      <select className={inputClass} value={draft.delegation_max_perm || "review"} onChange={e => setDraft({ ...draft, delegation_max_perm: e.target.value })}>
        <option value="review">review（全部走人工审批）</option>
        <option value="full">full（普通活自动合并，危险活仍人工审批）</option>
      </select>
    </label>}
  </div>;
}
