import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Play } from "lucide-react";
import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, keys } from "../../lib/api";
import { isMergeTask } from "../../lib/taskmeta";
import type { Project, Role, Session, Task, TaskTemplate } from "../../types";
import { Button, cn, Dialog, Field, inputClass, useToast } from "../ui";
import { WorkflowDialog } from "../../pages/workflows";
import { cronFromFields, SCHED_DEFAULT_TIME, ScheduleToggle } from "./schedule-fields";

type CreateKind = "task" | "session" | "workflow";

export function NewTaskDialog({ open, onOpenChange, initialProjectID }: { open: boolean; onOpenChange(open: boolean): void; initialProjectID?: number }) {
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const roles = useQuery({ queryKey: keys.roles, queryFn: () => api<Role[]>("/roles"), enabled: open });
  const projects = useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/projects"), enabled: open });
  const templates = useQuery({ queryKey: ["templates"], queryFn: () => api<TaskTemplate[]>("/templates"), enabled: open });
  const [kind, setKind] = useState<CreateKind>("task");
  // 单任务表单
  const [form, setForm] = useState({ title: "", body: "", role_id: "", project_id: initialProjectID ? String(initialProjectID) : "", perm: "full", run_mode: "batch", concurrent: false, dependency_mode: "weak", depends_on: "", block_on_failure: false });
  // 会话表单
  const [sessionForm, setSessionForm] = useState({ title: "", body: "", role_id: "", project_id: initialProjectID ? String(initialProjectID) : "", perm: "full" });
  // 定时属性（正交）：任务/会话都可勾选；cron 非空 = 定时定义，永不直接执行
  const [cronForm, setCronForm] = useState({ frequency: "daily", weekday: "1", monthday: "1", time: SCHED_DEFAULT_TIME });
  const [taskSched, setTaskSched] = useState(false);
  const [sessSched, setSessSched] = useState(false);
  const [schedEnabled, setSchedEnabled] = useState(true);
  const strongDeps = useQuery({ queryKey: keys.tasks, queryFn: () => api<Task[]>("/tasks"), enabled: open && kind === "task" && !taskSched && form.dependency_mode === "strong" });
  const create = useMutation({ mutationFn: () => api<Task>("/tasks", { method: "POST", body: { ...form, role_id: Number(form.role_id), project_id: Number(form.project_id), concurrent: form.concurrent, dependency_mode: form.dependency_mode, depends_on: form.dependency_mode === "strong" && form.depends_on ? Number(form.depends_on) : null, block_on_failure: form.block_on_failure } }), onSuccess: task => { void queryClient.invalidateQueries({ queryKey: keys.tasks }); onOpenChange(false); toast(`已创建任务 #${task.id}`); navigate(`/tasks/${task.id}`); }, onError: error => toast((error as Error).message, "bad") });
  const createScheduledTask = useMutation({
    mutationFn: () => {
      const cron = cronFromFields(cronForm.frequency, cronForm.weekday, cronForm.monthday, cronForm.time);
      if (!cron) throw new Error("请选择有效的执行时间");
      return api<Task>("/tasks", { method: "POST", body: { title: form.title, body: form.body, role_id: Number(form.role_id), project_id: Number(form.project_id), perm: form.perm, block_on_failure: form.block_on_failure, cron, enabled: schedEnabled } });
    },
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: keys.tasks }); onOpenChange(false); toast("已创建定时任务定义"); navigate("/schedules"); },
    onError: error => toast((error as Error).message, "bad")
  });
  const createSession = useMutation({
    mutationFn: async () => {
      const ss = await api<Session>("/sessions", { method: "POST", body: { role_id: Number(sessionForm.role_id), project_id: sessionForm.project_id ? Number(sessionForm.project_id) : null, title: sessionForm.title || undefined, perm: sessionForm.perm } });
      await api(`/sessions/${ss.id}/start`, { method: "POST" });
      if (sessionForm.body.trim()) await api(`/sessions/${ss.id}/prompt`, { method: "POST", body: { message: sessionForm.body, streaming_behavior: "follow_up" } });
      return ss;
    },
    onSuccess: ss => { void queryClient.invalidateQueries({ queryKey: keys.sessions }); onOpenChange(false); toast(`已创建会话 #${ss.id}`); navigate(`/sessions/${ss.id}`); },
    onError: error => toast((error as Error).message, "bad")
  });
  const createScheduledSession = useMutation({
    mutationFn: () => {
      const cron = cronFromFields(cronForm.frequency, cronForm.weekday, cronForm.monthday, cronForm.time);
      if (!cron) throw new Error("请选择有效的执行时间");
      return api<Session>("/sessions", { method: "POST", body: { role_id: Number(sessionForm.role_id), project_id: sessionForm.project_id ? Number(sessionForm.project_id) : null, title: sessionForm.title, body: sessionForm.body, cron, enabled: schedEnabled } });
    },
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: keys.tasks }); onOpenChange(false); toast("已创建定时会话定义"); navigate("/schedules"); },
    onError: error => toast((error as Error).message, "bad")
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (kind === "task") {
      if (taskSched) createScheduledTask.mutate();
      else create.mutate();
    } else if (kind === "session") {
      if (sessSched) createScheduledSession.mutate();
      else createSession.mutate();
    }
  };
  const kindTabs: Array<[CreateKind, string]> = [["task", "任务"], ["session", "会话"], ["workflow", "工作流"]];
  // 选择工作流形态直接进入构建器（不再经「打开工作流构建器」中转按钮）；
  // 关闭构建器后回到任务/会话表单，避免下次打开仍停留在工作流。
  if (kind === "workflow") {
    return <WorkflowDialog open={open} onOpenChange={next => { onOpenChange(next); if (!next) setKind("task"); }} projects={projects.data} roles={roles.data} initialProjectID={initialProjectID} />;
  }
  return <><Dialog open={open} onOpenChange={onOpenChange} title="新建任务" description="在项目的任务系统中创建任务；定时是正交属性——任何形态都可挂 cron，到点自动创建实例。" wide>
    <form className="grid gap-4" onSubmit={submit}>
      <div className="flex w-fit items-center gap-1 rounded-lg border border-line bg-elevated p-1 text-sm">
        {kindTabs.map(([value, label]) => <button key={value} type="button" onClick={() => setKind(value)} className={cn("flex items-center gap-1.5 rounded-md px-3 py-1.5 transition", kind === value ? "bg-surface font-medium text-ink shadow-sm" : "text-muted hover:text-ink")}>{label}</button>)}
      </div>

      {kind === "task" ? <>
        <Field label="标题"><input className={inputClass} required value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} autoFocus /></Field>
        <Field label="从模板插入"><select className={inputClass} value="" onChange={event => { const item = templates.data?.find(value => value.id === Number(event.target.value)); if (item) setForm(current => ({ ...current, title: current.title || item.name, body: current.body ? `${current.body}\n\n${item.body}` : item.body })); }}><option value="">选择模板…</option>{templates.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
        <Field label="任务说明"><textarea className={inputClass + " min-h-32 py-3"} value={form.body} onChange={event => setForm({ ...form, body: event.target.value })} placeholder="可选" /></Field>
        <div className="grid gap-4 sm:grid-cols-2"><Field label="项目"><select className={inputClass} required value={form.project_id} onChange={event => setForm({ ...form, project_id: event.target.value, depends_on: "" })}><option value="">选择项目</option>{projects.data?.filter(item => item.status === "active").map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label="角色"><select className={inputClass} required value={form.role_id} onChange={event => setForm({ ...form, role_id: event.target.value })}><option value="">选择角色</option>{roles.data?.filter(item => item.enabled).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field></div>
        <div className="grid gap-4 sm:grid-cols-2"><Field label="权限"><select className={inputClass} value={form.perm} onChange={event => setForm({ ...form, perm: event.target.value })}><option value="full">自动整合</option><option value="review">人工审批</option></select></Field>{!taskSched && <Field label="运行方式"><select className={inputClass} value={form.run_mode} onChange={event => setForm({ ...form, run_mode: event.target.value })}><option value="batch">批处理</option><option value="interactive">交互终端</option></select></Field>}</div>
        {!taskSched ? <>
          <div className="grid gap-4 sm:grid-cols-2"><Field label="依赖模式"><select className={inputClass} value={form.dependency_mode} onChange={event => setForm({ ...form, dependency_mode: event.target.value, depends_on: "" })}><option value="weak">自动顺序（默认）</option><option value="none">独立执行</option><option value="strong">明确前置</option></select></Field><Field label="失败后"><select className={inputClass} value={form.block_on_failure ? "1" : "0"} onChange={event => setForm({ ...form, block_on_failure: event.target.value === "1" })}><option value="0">后续弱依赖可跳过</option><option value="1">阻塞后续弱依赖</option></select></Field></div>
          {form.dependency_mode === "strong" ? <Field label="前置任务"><select className={inputClass} required value={form.depends_on} onChange={event => setForm({ ...form, depends_on: event.target.value })}><option value="">选择前置任务</option>{(strongDeps.data || []).filter(item => item.project_id === Number(form.project_id) && !isMergeTask(item)).sort((a, b) => b.id - a.id).map(item => <option key={item.id} value={item.id}>#{item.id} · {item.title}</option>)}</select></Field> : null}
          <label className="flex min-h-11 items-center gap-3 rounded-xl border border-line bg-elevated px-3 text-sm"><input type="checkbox" checked={form.concurrent} onChange={event => setForm({ ...form, concurrent: event.target.checked })} />允许与同项目其他任务并行</label>
        </> : null}
        <ScheduleToggle checked={taskSched} onChange={setTaskSched} enabled={schedEnabled} onEnabledChange={setSchedEnabled} cronForm={cronForm} onCronChange={patch => setCronForm(current => ({ ...current, ...patch }))} />
      </> : kind === "session" ? <>
        <Field label="标题"><input className={inputClass} value={sessionForm.title} onChange={event => setSessionForm({ ...sessionForm, title: event.target.value })} placeholder="默认使用角色名称" autoFocus /></Field>
        <div className="grid gap-4 sm:grid-cols-2"><Field label="项目"><select className={inputClass} value={sessionForm.project_id} onChange={event => setSessionForm({ ...sessionForm, project_id: event.target.value })}><option value="">不绑定项目</option>{projects.data?.filter(item => item.status === "active").map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label="角色"><select className={inputClass} required value={sessionForm.role_id} onChange={event => setSessionForm({ ...sessionForm, role_id: event.target.value })}><option value="">请选择</option>{roles.data?.filter(item => item.enabled && ["pi", "omp", "dsh"].includes(item.runtime_id)).map(item => <option key={item.id} value={item.id}>{item.name} · {item.runtime_id}</option>)}</select></Field></div>
        <div className="grid gap-4 sm:grid-cols-2"><Field label="权限"><select className={inputClass} value={sessionForm.perm} onChange={event => setSessionForm({ ...sessionForm, perm: event.target.value })}><option value="full">自动整合（免审批）</option><option value="review">人工审批</option></select></Field></div>
        <Field label="初始指令"><textarea className={inputClass + " min-h-28 py-3"} value={sessionForm.body} onChange={event => setSessionForm({ ...sessionForm, body: event.target.value })} placeholder={sessSched ? "到点创建会话后自动发送的初始指令" : "可选：创建后自动启动并发起首轮对话"} /></Field>
        <ScheduleToggle checked={sessSched} onChange={setSessSched} enabled={schedEnabled} onEnabledChange={setSchedEnabled} cronForm={cronForm} onCronChange={patch => setCronForm(current => ({ ...current, ...patch }))} />
      </> : null}

      {kind === "task" ? <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" variant="primary" disabled={create.isPending || createScheduledTask.isPending}>{taskSched ? <><CalendarClock size={16} />创建定时定义</> : <><Play size={16} />创建并排队</>}</Button></div>
        : kind === "session" ? <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" variant="primary" disabled={createSession.isPending || createScheduledSession.isPending}>{sessSched ? <><CalendarClock size={16} />创建定时定义</> : <><Play size={16} />创建并启动</>}</Button></div>
        : null}
    </form>
  </Dialog>
  </>;
}
