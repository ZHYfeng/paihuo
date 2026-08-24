import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ListTree, RotateCcw, Save, TerminalSquare, Trash2, X } from "lucide-react";
import { FormEvent, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { DiffView } from "../../components/diff-view";
import { PageHeader } from "../../components/shell";
import { TaskTerminal } from "../../components/terminal";
import { DependencyChip, DependencyStateChip, SourceMergeChip, TaskDependencyEditor } from "../../components/task/dependency-editor";
import { ChildrenSections, LogFilterToggle, TaskBody, WorkspaceCard } from "../../components/task/detail";
import { formatBytes } from "../../components/task/format";
import { TaskStatus } from "../../components/task/status";
import { avatarInitial } from "../../components/task/task-card";
import { Button, Card, Dialog, Empty, Field, inputClass, Spinner, useToast } from "../../components/ui";
import { useTasks } from "../../hooks/useTasks";
import { api, keys } from "../../lib/api";
import { STATUS_LABEL, canRetryTask, cleanLogContent, dependencyInfo, isMergeTask, mergeBlockReason, retryTaskLabel, terminalRenderableLog, tsOf } from "../../lib/taskmeta";
import type { Artifact, Project, Role, Task, TaskLog, TaskLogPage } from "../../types";

export function TaskDetailPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [logFilter, setLogFilter] = useState<"all" | "err">("all");
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectNote, setRejectNote] = useState("");
  const task = useQuery({ queryKey: keys.task(id), queryFn: () => api<Task>(`/tasks/${id}`), refetchInterval: 5000 });
  const tasks = useTasks();
  const roles = useQuery({ queryKey: keys.roles, queryFn: () => api<Role[]>("/roles") });
  const projects = useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/projects") });
  const logs = useQuery({ queryKey: ["tasks", id, "logs"], queryFn: () => api<TaskLogPage>(`/tasks/${id}/logs?limit=500`), refetchInterval: task.data?.status === "running" ? 1500 : false });
  const [olderLogs, setOlderLogs] = useState<TaskLog[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const allLogs = [...olderLogs, ...(logs.data?.logs || [])];
  const diff = useQuery({ queryKey: ["tasks", id, "diff"], queryFn: () => api<{ stat: string; diff: string; note?: string }>(`/tasks/${id}/diff`) });
  const artifacts = useQuery({ queryKey: ["tasks", id, "artifacts"], queryFn: () => api<Artifact[]>(`/artifacts?task_id=${id}`) });
  const mutate = useMutation({ mutationFn: (body: Record<string, unknown>) => api<Task>(`/tasks/${id}`, { method: "PATCH", revision: task.data?.revision, body }), onSuccess: value => { queryClient.setQueryData(keys.task(id), value); void queryClient.invalidateQueries({ queryKey: keys.tasks }); queryClient.invalidateQueries({ queryKey: keys.stats }); toast("任务已更新"); }, onError: error => toast((error as Error).message, "bad") });
  const remove = useMutation({ mutationFn: () => api<void>(`/tasks/${id}`, { method: "DELETE", revision: task.data?.revision }), onSuccess: () => { toast("任务已删除"); navigate("/board"); }, onError: error => toast((error as Error).message, "bad") });
  const [subtaskOpen, setSubtaskOpen] = useState(false);
  const [subtask, setSubtask] = useState({ title: "", body: "", role_id: "" });
  const createSubtask = useMutation({
    mutationFn: () => api<Task>("/tasks", { method: "POST", body: { title: subtask.title, body: subtask.body, role_id: Number(subtask.role_id), project_id: task.data?.project_id ?? null, perm: task.data?.perm || "full", run_mode: "batch", concurrent: false, dependency_mode: task.data?.project_id ? "weak" : "none", block_on_failure: false, parent_id: id, ...(task.data?.project_id ? { depends_on: id } : {}) } }),
    onSuccess: () => { setSubtaskOpen(false); setSubtask({ title: "", body: "", role_id: "" }); void queryClient.invalidateQueries({ queryKey: ["tasks", id, "children"] }); toast("子任务已创建并排队"); },
    onError: error => toast((error as Error).message, "bad")
  });
  const resume = useMutation({
    mutationFn: () => api<Task>(`/tasks/${id}/resume`, { method: "POST" }),
    onSuccess: () => { toast("已在原任务中重新排队"); void queryClient.invalidateQueries({ queryKey: keys.tasks }); void queryClient.invalidateQueries({ queryKey: keys.task(id) }); },
    onError: error => toast((error as Error).message, "bad")
  });
  const endSession = useMutation({
    mutationFn: () => api<{ sent: string }>(`/tasks/${id}/end-session`, { method: "POST" }),
    onSuccess: data => { toast(`已发送 ${data.sent}，等待 agent 退出`); },
    onError: error => toast((error as Error).message, "bad")
  });
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const saveTemplate = useMutation({
    mutationFn: () => api("/templates", { method: "POST", body: { name: templateName || task.data?.title || `任务 #${id}`, body: task.data?.body || "", role_id: task.data?.role_id ?? null } }),
    onSuccess: () => { setTemplateOpen(false); setTemplateName(""); toast("已保存为模板"); void queryClient.invalidateQueries({ queryKey: ["templates"] }); },
    onError: error => toast((error as Error).message, "bad")
  });
  const loadOlder = async () => {
    if (!allLogs.length || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await api<TaskLogPage>(`/tasks/${id}/logs?limit=200&before=${allLogs[0].id}`);
      setOlderLogs(prev => [...page.logs, ...prev]);
    } catch (error) {
      toast((error as Error).message, "bad");
    } finally {
      setLoadingOlder(false);
    }
  };
  const copyLogs = async () => {
    try {
      const data = await api<TaskLog[]>(`/tasks/${id}/logs?all=1`);
      await navigator.clipboard.writeText(data.map(log => log.content).join(""));
      toast(`已复制 ${data.length} 条日志`);
    } catch (error) {
      toast((error as Error).message, "bad");
    }
  };
  if (task.isLoading) return <Spinner />;
  if (!task.data) return <Empty title="任务不存在" copy="该任务可能已被删除。" />;
  const value = task.data;
  const all = tasks.data || [];
  const mergeTask = isMergeTask(value);
  const dependency = dependencyInfo(value, all);
  const mergeSource = mergeTask ? all.find(t => t.id === value.merge_of) : null;
  const mergeBlocked = mergeTask ? mergeBlockReason(value, roles.data || []) : "";
  const interactive = value.run_mode === "interactive";
  const isLive = interactive && ["claimed", "running"].includes(value.status);
  const runMode = interactive ? "交互式" : "批处理";
  const createdAt = String(value.created_at || "").slice(0, 16).replace("T", " ");
  const renderableLogs = allLogs.filter(terminalRenderableLog);
  const visibleLogs = renderableLogs.filter(l => cleanLogContent(l.content).trim()).length;
  const logErrors = allLogs.filter(l => l.stream === "err").length;
  const logMeta = interactive
    ? isLive ? "实时画面 · 跟随浏览器尺寸" : `已归档画面 · ${value.terminal_cols || 80} × ${value.terminal_rows || 24}`
    : logs.data?.has_more || olderLogs.length ? `已加载 ${visibleLogs}/${logs.data?.total ?? visibleLogs} 条` : `${visibleLogs} 条`;
  const dependencyAlert = !mergeTask && value.status === "queued" && dependency.state !== "ready"
    ? <div className="task-alert"><span className="task-alert-title">{dependency.state === "skipped" ? "前序交付已跳过" : "等待前置交付"}</span><span>{dependency.reason || "等待调度"}</span></div> : null;
  const errorAlert = value.error ? <div className="task-alert"><span className="task-alert-title">{mergeTask ? "代码合并失败" : "任务失败"}</span><span>{value.error}</span></div> : null;
  const statusOpts = Object.keys(STATUS_LABEL).map(s => <option key={s} value={s} selected={s === value.status}>{STATUS_LABEL[s]}</option>);
  const agentOpts = <><option value="">不指派</option>{roles.data?.filter(a => a.enabled || a.id === value.role_id).map(a => <option key={a.id} value={a.id} selected={a.id === value.role_id}>{a.name}</option>)}</>;
  const pOpts = <><option value="">无项目</option>{projects.data?.map(p => <option key={p.id} value={p.id} selected={p.id === value.project_id}>{p.name}</option>)}</>;
  const canMoveProject = value.dependency_mode === "none" && !value.depends_on;
  const filteredLogs = logFilter === "err" ? allLogs.filter(l => l.stream === "err") : allLogs;
  return <>
    <PageHeader title={value.title} copy={`${value.project_name || "无项目"} · ${value.role_name || "未指派"}`} actions={<><TaskStatus status={value.status} /><Button variant="ghost" onClick={() => navigate(-1)}>返回</Button></>} />
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0">
        <section className="task-hero">
          <div className="task-kicker"><span>{mergeTask ? `代码合并任务 · 来源 #${value.merge_of}` : `实现任务 #${value.id}`}</span><span>创建于 {createdAt}</span></div>
          <h2>{value.title}</h2>
          <div className="task-meta">
            <span className="task-meta-item"><span className="grid size-5 place-items-center rounded-full bg-brand/10 text-[10px] font-semibold text-brand-soft">{avatarInitial(value.role_name || "?")}</span>{value.role_name || "未指派"}</span>
            {value.project_name ? <span className="task-meta-item">{value.project_name}</span> : null}
            <span className="task-meta-item">{runMode}</span>
            {!mergeTask ? <DependencyChip task={value} tasks={all} /> : null}
            {!mergeTask ? <DependencyStateChip task={value} tasks={all} /> : null}
            {mergeTask ? <span className="task-meta-item task-meta-accent">{mergeSource ? `源任务：#${mergeSource.id}` : `源任务：#${value.merge_of}`}</span> : <SourceMergeChip task={value} tasks={all} />}
            {value.resume_of ? <span className="task-meta-item task-meta-accent">续跑自 #{value.resume_of}</span> : null}
          </div>
        </section>
        {value.body ? <details className="task-section task-prompt" open={value.body.length <= 160}>
          <summary><span>任务说明</span><span className="section-meta">{value.body.length} 字</span></summary>
          <TaskBody task={value} />
        </details> : null}
        {dependencyAlert}
        {errorAlert}
        <ChildrenSections task={value} onOpen={id => navigate(`/tasks/${id}`)} />
        <details className="task-section task-diff" open={value.status === "awaiting_review" || value.status === "running"}>
          <summary><span>代码改动</span><span className="section-meta">{value.status === "awaiting_review" ? "等待审批" : "git diff"}</span></summary>
          <div className="pt-2">{diff.isLoading ? <Spinner /> : <DiffView taskId={id} status={value.status} stat={diff.data?.stat} diff={diff.data?.diff || ""} note={diff.data?.note} />}</div>
        </details>
        <details className="task-section task-log-section" open={isLive || !interactive}>
          <summary><span>{interactive ? "交互终端" : "执行记录"}</span><span className="section-meta">{logMeta}{logErrors && !interactive ? ` · ${logErrors} 个错误` : ""}</span></summary>
          <div className="section-head">
            <div className="section-sub">{value.role_name || "未指派"} · {runMode}</div>
            <div className="section-tools">
              {interactive ? null : <LogFilterToggle mode={logFilter} onToggle={() => setLogFilter(logFilter === "err" ? "all" : "err")} />}
              <Button size="sm" variant="ghost" onClick={() => void copyLogs()}><Copy size={14} />{interactive ? "复制画面" : "复制"}</Button>
            </div>
          </div>
          {interactive
            ? <TaskTerminal task={value} logs={renderableLogs} onLoadOlder={loadOlder} hasMore={logs.data?.has_more || false} />
            : <div className="log-lines mt-2" onScroll={e => { if (e.currentTarget.scrollTop <= 64) loadOlder(); }}>
              {filteredLogs.map((log, index) => {
                const content = cleanLogContent(log.content);
                if (!content.trim() && log.stream !== "sys") return null;
                return <div key={log.id}>
                  {logFilter === "err" && index > 0 && filteredLogs[index - 1].stream !== "err" ? <div className="err-divider" /> : null}
                  <div className="line"><span className="ts">{tsOf(log)}</span><span className={`c ${log.stream}`}>{content}</span></div>
                </div>;
              })}
              {!renderableLogs.length ? <div className="line"><span className="ts" /><span className="c out">（暂无输出）</span></div> : null}
            </div>}
        </details>
        <WorkspaceCard task={value} />
      </div>
      <aside className="grid content-start gap-3">
        {mergeTask
          ? <details className="side-collapse side-properties" open>
            <summary><span>合并任务属性</span><span className="section-meta">系统管理</span></summary>
            <div className="side-collapse-body">
              <div className="prop-row"><span className="k">来源</span><span className="v"><Button size="sm" variant="ghost" onClick={() => navigate(`/tasks/${value.merge_of}`)}>任务 #{value.merge_of}</Button></span></div>
              <div className="prop-row"><span className="k">状态</span><span className="v">{STATUS_LABEL[value.status] || value.status}</span></div>
              <div className="prop-row"><span className="k">角色</span><span className="v">
                {value.status === "queued"
                  ? <span className="flex flex-wrap items-center gap-1.5"><select value={value.role_id ?? ""} onChange={e => { const v = e.target.value; mutate.mutate(v ? { role_id: Number(v) } : { role_id: null }); }} className={inputClass + " py-0.5 text-xs"} aria-label="更换合并任务角色">{roles.data?.filter(a => a.enabled || a.id === value.role_id).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>{mergeBlocked ? <span className="text-danger">{mergeBlocked}</span> : null}</span>
                  : <>{value.role_name || "未指派"}{mergeBlocked ? ` · ${mergeBlocked}` : ""}</>}
              </span></div>
              <div className="prop-row"><span className="k">策略</span><span className="v">独立 worktree · 串行 · 无冲突时平台自动合并，冲突时 agent 整合后写入主分支{mergeSource?.block_on_failure ? " · 失败阻塞后续自动任务" : " · 失败可跳过"}</span></div>
            </div>
          </details>
          : <details className="side-collapse side-properties" open>
            <summary><span>任务属性</span><span className="section-meta">可编辑</span></summary>
            <div className="side-collapse-body">
              <div className="prop-row"><span className="k">状态</span><span className="v"><select className={inputClass} onChange={e => mutate.mutate({ status: e.target.value })}>{statusOpts}</select></span></div>
              <div className="prop-row"><span className="k">项目</span><span className="v"><select className={inputClass} disabled={!canMoveProject} title={canMoveProject ? undefined : "有前置依赖的任务不能改项目"} onChange={e => mutate.mutate({ project_id: e.target.value ? Number(e.target.value) : null })}>{pOpts}</select></span></div>
              <div className="prop-row"><span className="k">角色</span><span className="v"><select className={inputClass} aria-label="任务角色" onChange={e => mutate.mutate({ role_id: e.target.value ? Number(e.target.value) : null })}>{agentOpts}</select></span></div>
              <div className="prop-row"><span className="k">权限</span><span className="v"><select className={inputClass} value={value.perm} disabled={mutate.isPending} aria-label="任务权限" onChange={e => mutate.mutate({ perm: e.target.value })}><option value="full">自动整合</option><option value="review">人工审批</option></select></span></div>
              <div className="prop-row"><span className="k">方式</span><span className="v">{runMode}</span></div>
              <div className="prop-row"><span className="k">前置交付</span><span className="v">{value.type === "task" && !value.cron
                ? <TaskDependencyEditor key={`${value.id}-${value.project_id ?? "none"}-${value.dependency_mode}-${value.depends_on ?? "none"}`} task={value} tasks={all} disabled={mutate.isPending} onChange={body => mutate.mutate(body)} />
                : <><DependencyChip task={value} tasks={all} />{value.cron ? <span className="text-xs text-faint">定时定义不参与前置交付</span> : null}{dependency.state !== "ready" ? <span title={dependency.reason || ""}>{dependency.stateLabel || dependency.reason || "等待"}</span> : null}</>}</span></div>
              <div className="prop-row"><span className="k">失败后</span><span className="v"><select className={inputClass} onChange={e => mutate.mutate({ block_on_failure: e.target.value === "1" })}><option value="0" selected={!value.block_on_failure}>后续弱依赖可跳过</option><option value="1" selected={value.block_on_failure}>阻塞后续弱依赖</option></select></span></div>
              <div className="prop-row"><span className="k">并发</span><span className="v"><select className={inputClass} onChange={e => mutate.mutate({ concurrent: e.target.value === "1" })}><option value="0" selected={!value.concurrent}>不重叠执行（默认）</option><option value="1" selected={value.concurrent}>允许资源并发</option></select></span></div>
            </div>
          </details>}
        <details className="side-collapse"><summary><span>运行信息</span><span className="section-meta">技术细节</span></summary>
          <div className="side-collapse-body">
            <div className="prop-row"><span className="k">执行器</span><span className="v">tmux · {["claimed", "running"].includes(value.status) ? `paihuo:task-${value.id}` : "日志已归档"}</span></div>
            <div className="prop-row"><span className="k">目录</span><span className="v prop-mono" title={value.project_dir || ""}>{value.project_dir || "-"}</span></div>
            <div className="prop-row"><span className="k">审批轮次</span><span className="v">{value.review_rounds || "-"}</span></div>
            <div className="prop-row"><span className="k">开始</span><span className="v">{String(value.started_at || "-").slice(0, 16).replace("T", " ")}</span></div>
            <div className="prop-row"><span className="k">结束</span><span className="v">{String(value.finished_at || "-").slice(0, 16).replace("T", " ")}</span></div>
          </div>
        </details>
        {artifacts.data?.length ? <Card><h2 className="font-semibold">Artifacts</h2><div className="mt-3 grid gap-2">{artifacts.data.map(item => <a key={item.id} className="rounded-lg border border-line p-3 text-sm hover:border-brand/40" href={`/api/v1/artifacts/${item.id}/content`}><span className="block truncate font-medium">{item.name}</span><span className="mt-1 block text-xs text-muted">{item.media_type} · {formatBytes(item.size)}</span></a>)}</div></Card> : null}
        <section className="side-actions">
          <div className="side-heading">下一步</div>
          <div className="detail-actions">
            {["queued", "claimed", "running"].includes(value.status) ? <Button variant="danger" onClick={() => { if (confirm("取消该任务？")) mutate.mutate({ status: "cancelled" }); }}><X size={15} />取消任务</Button> : null}
            {interactive && value.status === "running" ? <Button onClick={() => { if (confirm("结束交互会话？将向终端发送该 CLI 的退出命令（pi 为 /quit），agent 收尾后任务按正常退出结果结算。")) endSession.mutate(); }}><TerminalSquare size={15} />结束会话</Button> : null}
            {value.status === "awaiting_review" ? <>
              <Button variant="primary" onClick={() => { mutate.mutate({ status: "succeeded" }); toast("已审批，代码合并任务已派发"); }}><Check size={15} />通过并派发合并</Button>
              <Button onClick={() => { setRejectNote(""); setRejectOpen(true); }}><RotateCcw size={15} />驳回重做</Button>
              <Button variant="danger" onClick={() => { if (confirm("取消该任务？")) mutate.mutate({ status: "cancelled" }); }}><X size={15} />取消</Button>
            </> : null}
            {canRetryTask(value, all) ? <Button onClick={() => mutate.mutate({ status: "queued" })}><RotateCcw size={15} />{retryTaskLabel(value)}</Button> : null}
            {canRetryTask(value, all) && !mergeTask ? <Button onClick={() => { if (confirm(`继续任务 #${value.id}？将保留任务编号、任务会话目录、工作空间和历史记录，重新排队执行。`)) resume.mutate(); }}><TerminalSquare size={15} />继续对话</Button> : null}
            {!["queued", "claimed", "running", "awaiting_review"].includes(value.status) && <span className="side-muted">暂无需要处理的操作</span>}
          </div>
          <details className="side-more-actions">
            <summary>更多操作</summary>
            <div className="detail-actions">
              {mergeTask
                ? <Button variant="ghost" onClick={() => navigate(`/tasks/${value.merge_of}`)}>打开源任务 #{value.merge_of}</Button>
                : <>
                  <Button variant="ghost" onClick={() => setSubtaskOpen(true)}><ListTree size={15} />拆分子任务</Button>
                  {value.body ? <Button variant="ghost" onClick={() => { setTemplateName(value.title); setTemplateOpen(true); }}><Save size={15} />保存为模板</Button> : null}
                  <Button variant="ghost" onClick={() => { if (confirm("确定删除这个任务及其工作空间？")) remove.mutate(); }}><Trash2 size={15} />删除任务</Button>
                </>}
            </div>
          </details>
        </section>
      </aside>
    </div>
    <Dialog open={rejectOpen} onOpenChange={setRejectOpen} title="驳回重做" description="填写驳回原因 / 修改意见（将追加到任务提示词，重新执行）。">
      <form className="grid gap-4" onSubmit={(event: FormEvent) => { event.preventDefault(); mutate.mutate({ status: "queued", review_note: rejectNote }); setRejectOpen(false); toast("已驳回，任务重新执行"); }}>
        <Field label="驳回原因"><textarea className={inputClass + " min-h-28 py-3"} autoFocus required value={rejectNote} onChange={e => setRejectNote(e.target.value)} placeholder="例如：接口命名不符合规范，请改为…" /></Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setRejectOpen(false)}>取消</Button><Button type="submit" variant="primary">驳回并重新执行</Button></div>
      </form>
    </Dialog>
    <Dialog open={subtaskOpen} onOpenChange={setSubtaskOpen} title="拆分子任务" description="子任务继承当前项目的弱依赖，等待父任务交付后执行。"><form className="grid gap-4" onSubmit={(event: FormEvent) => { event.preventDefault(); createSubtask.mutate(); }}>
      <Field label="标题"><input className={inputClass} required value={subtask.title} onChange={e => setSubtask({ ...subtask, title: e.target.value })} /></Field>
      <Field label="任务说明"><textarea className={inputClass + " min-h-28 py-3"} value={subtask.body} onChange={e => setSubtask({ ...subtask, body: e.target.value })} placeholder="可选" /></Field>
      <Field label="角色"><select className={inputClass} required value={subtask.role_id} onChange={e => setSubtask({ ...subtask, role_id: e.target.value })}><option value="">选择角色</option>{roles.data?.filter(role => role.enabled).map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select></Field>
      <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setSubtaskOpen(false)}>取消</Button><Button type="submit" variant="primary" disabled={createSubtask.isPending}>创建子任务</Button></div>
    </form></Dialog>
    <Dialog open={templateOpen} onOpenChange={setTemplateOpen} title="保存为模板"><form className="grid gap-4" onSubmit={(event: FormEvent) => { event.preventDefault(); saveTemplate.mutate(); }}>
      <Field label="模板名称"><input className={inputClass} required value={templateName} onChange={e => setTemplateName(e.target.value)} /></Field>
      <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setTemplateOpen(false)}>取消</Button><Button type="submit" variant="primary" disabled={saveTemplate.isPending}>保存</Button></div>
    </form></Dialog>
  </>;
}

/* ---- 统一新建任务对话框：任务 / 会话 / 工作流 / 定时（定时是正交属性） ---- */
