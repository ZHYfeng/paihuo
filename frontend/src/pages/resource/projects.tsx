import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CirclePlus, FolderKanban, Pencil, Search, Trash2 } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { DirectoryPicker } from "../../components/directory-picker";
import { MutationError } from "../../components/project/mutation-error";
import { PageHeader } from "../../components/shell";
import { Badge, Button, Card, Dialog, Empty, Field, inputClass, Spinner, useToast } from "../../components/ui";
import { api, keys } from "../../lib/api";
import type { Project, Role, Task } from "../../types";

export function ProjectsPage() {
  const query = useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/projects") });
  const tasks = useQuery({ queryKey: keys.tasks, queryFn: () => api<Task[]>("/tasks") });
  const roles = useQuery({ queryKey: keys.roles, queryFn: () => api<Role[]>("/roles") });
  const qc = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Partial<Project> | null>(null);
  const [dirOpen, setDirOpen] = useState(false);
  const save = useMutation({
    mutationFn: (value: Partial<Project>) => value.id
      ? api<Project>(`/projects/${value.id}`, { method: "PATCH", revision: value.revision, body: { name: value.name, description: value.description, project_dir: value.project_dir, status: value.status, github_repo: value.github_repo || "", github_role_id: value.github_role_id ?? null, github_auto_issues: !!value.github_auto_issues, github_auto_prs: !!value.github_auto_prs, github_auto_security: !!value.github_auto_security } })
      : api<Project>("/projects", { method: "POST", body: value }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: keys.projects }); setEditing(null); toast("项目已保存"); }
  });
  const remove = useMutation({ mutationFn: (value: Project) => api<void>(`/projects/${value.id}`, { method: "DELETE", revision: value.revision }), onSuccess: () => qc.invalidateQueries({ queryKey: keys.projects }) });
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return query.data || [];
    return (query.data || []).filter(project => project.name.toLowerCase().includes(q) || (project.description || "").toLowerCase().includes(q));
  }, [query.data, search]);
  return <>
    <PageHeader title="项目" copy="项目定义代码目录、隔离边界与工作流归属。" actions={<Button variant="primary" onClick={() => setEditing({ status: "active" })}><CirclePlus size={17} />新建项目</Button>} />
    <Card className="mb-4 flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
      <span className="flex items-center gap-2 px-2 text-sm text-muted"><Search size={16} />搜索</span>
      <input className={inputClass + " sm:w-64"} placeholder="搜索项目…" value={search} onChange={e => setSearch(e.target.value)} aria-label="搜索项目" />
      <span className="text-sm text-muted sm:ml-auto">{visible.length} 个项目</span>
    </Card>
    {query.isLoading ? <Spinner /> : visible.length ? <div className="grid gap-3 lg:grid-cols-2">{visible.map(project => {
      const ts = (tasks.data || []).filter(t => t.project_id === project.id);
      const source = ts.filter(t => t.merge_of == null);
      const merges = ts.filter(t => t.merge_of != null);
      const done = source.filter(t => t.status === "succeeded").length;
      const pct = source.length ? Math.round(done / source.length * 100) : 0;
      const roles = new Set(ts.map(t => t.role_name).filter(Boolean));
      return <Link key={project.id} to={`/projects/${project.id}`} className="project-card rounded-xl border border-line bg-surface p-3.5 shadow-card transition hover:border-brand/35">
        <div className="flex items-start gap-3">
          <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{project.name}</h2>{project.is_git ? <span className="chip git-chip" title="git 仓库，任务将获得独立 worktree">git</span> : <span className="chip" title="非 git 仓库，任务直接在项目目录执行">非 git</span>}<Badge tone={project.status === "active" ? "good" : "neutral"}>{project.status === "active" ? "进行中" : "已归档"}</Badge></div>
          {project.description ? <p className="mt-2 text-sm leading-6 text-muted">{project.description}</p> : null}</div>
          <div className="ml-auto flex gap-1"><Button size="sm" variant="ghost" aria-label={`编辑 ${project.name}`} onClick={e => { e.preventDefault(); setEditing(project); }}><Pencil size={15} /></Button><Button size="sm" variant="danger" aria-label={`删除 ${project.name}`} onClick={e => { e.preventDefault(); if (confirm(`删除项目“${project.name}”？`)) remove.mutate(project); }}><Trash2 size={15} /></Button></div>
        </div>
        <div className="pc-progress mt-3"><div className="pp-bar"><div style={{ width: `${pct}%` }} /></div><span className="pc-pct">{pct}%</span></div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          {project.project_dir ? <code className="max-w-56 truncate" title={project.project_dir}>{project.project_dir}</code> : null}
          <span>{source.length} 任务</span>
          {merges.length ? <span>{merges.length} 合并</span> : null}
          <span>{done} 实现完成</span>
          <span>{roles.size} 角色</span>
          <span className="ml-auto">{formatTime(project.updated_at || project.created_at)}</span>
        </div>
      </Link>;
    })}</div> : <Empty title={search ? "没有匹配的项目" : "还没有项目"} copy={search ? "调整搜索条件。" : "创建项目并绑定代码目录，任务和工作流才有明确的执行边界。"} />}
    <Dialog open={editing !== null} onOpenChange={open => !open && setEditing(null)} title={editing?.id ? "编辑项目" : "新建项目"}>
      {editing && <form className="grid gap-4" onSubmit={(event: FormEvent) => { event.preventDefault(); save.mutate(editing); }}>
        <Field label="名称"><input className={inputClass} required value={editing.name || ""} onChange={e => setEditing({ ...editing, name: e.target.value })} /></Field>
        <Field label="说明"><textarea className={inputClass + " min-h-24 py-3"} value={editing.description || ""} onChange={e => setEditing({ ...editing, description: e.target.value })} /></Field>
        <Field label="代码目录" hint="使用主机上的绝对路径，或浏览选择目录。"><div className="flex gap-2"><input className={inputClass} value={editing.project_dir || ""} onChange={e => setEditing({ ...editing, project_dir: e.target.value })} /><Button type="button" onClick={() => setDirOpen(true)}><FolderKanban size={16} />浏览</Button></div></Field>
        <div className="rounded-xl border border-line bg-elevated p-3"><div className="mb-2 text-sm font-semibold">GitHub 集成</div>
          <div className="grid gap-3">
            <Field label="GitHub 仓库" hint="例如 owner/repo；留空表示不启用 GitHub 集成。"><input className={inputClass} value={editing.github_repo || ""} onChange={e => setEditing({ ...editing, github_repo: e.target.value })} placeholder="owner/repo" /></Field>
            <Field label="自动处理角色" hint="自动创建的 GitHub 任务默认指派给该角色；可不选，稍后手动指派。"><select className={inputClass} value={editing.github_role_id ?? ""} onChange={e => setEditing({ ...editing, github_role_id: e.target.value ? Number(e.target.value) : null })}><option value="">不自动指派</option>{roles.data?.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select></Field>
            <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={!!editing.github_auto_issues} onChange={e => setEditing({ ...editing, github_auto_issues: e.target.checked })} />自动处理 Issue</label>
            <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={!!editing.github_auto_prs} onChange={e => setEditing({ ...editing, github_auto_prs: e.target.checked })} />自动处理 PR</label>
            <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={!!editing.github_auto_security} onChange={e => setEditing({ ...editing, github_auto_security: e.target.checked })} />自动处理安全告警</label>
          </div>
        </div>
        {editing.id && <Field label="状态"><select className={inputClass} value={editing.status} onChange={e => setEditing({ ...editing, status: e.target.value as Project["status"] })}><option value="active">活跃</option><option value="archived">归档</option></select></Field>}
        <MutationError value={save.error} /><div className="flex justify-end"><Button variant="primary" disabled={save.isPending}>保存</Button></div>
      </form>}
    </Dialog>
    <DirectoryPicker open={dirOpen} onOpenChange={setDirOpen} initial={editing?.project_dir} onPick={path => setEditing(current => {
      if (!current) return current;
      const next = { ...current, project_dir: path };
      // 创建项目时，确认选择文件夹后若名称为空，自动用文件夹名称填充。
      if (!current.id && !current.name?.trim()) next.name = folderName(path);
      return next;
    })} />
  </>;
}

// 从路径中提取文件夹名称（最后一段），供创建项目时自动填充项目名称。
function folderName(path: string): string {
  const trimmed = (path || "").trim().replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

function formatTime(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
