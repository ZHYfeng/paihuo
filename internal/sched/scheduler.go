// Package sched 实现定时任务调度：cron 触发 → 按形态实例化。
// 定时定义是 tasks 表中的任务（cron 非空）；触发语义：
//   - type=task：渲染 title/body 模板创建新任务实例；
//   - type=session：创建会话任务实例并自动启动、发送初始指令；
//   - type=workflow：从工作流定义创建一次 Run。
package sched

import (
	"context"
	"log"
	"strings"
	"text/template"
	"time"

	"github.com/robfig/cron/v3"

	"paihuo/internal/application"
	"paihuo/internal/events"
	"paihuo/internal/exec"
	"paihuo/internal/session"
	"paihuo/internal/store"
	"paihuo/internal/workflow"
)

type Scheduler struct {
	st   *store.Store
	hub  *events.EventStream
	ex   *exec.Executor
	sess *session.Manager
	wf   *application.WorkflowService
	cron *cron.Cron
	mu   chan struct{} // 串行化重载
}

func New(st *store.Store, hub *events.EventStream, ex *exec.Executor, sess *session.Manager, wf *application.WorkflowService) *Scheduler {
	return &Scheduler{
		st:   st,
		hub:  hub,
		ex:   ex,
		sess: sess,
		wf:   wf,
		// 平台统一使用包含秒字段的六段 cron 表达式。
		cron: cron.New(cron.WithParser(cron.NewParser(
			cron.Second|cron.Minute|cron.Hour|cron.Dom|cron.Month|cron.Dow|cron.Descriptor,
		)), cron.WithLocation(time.Local)),
		mu: make(chan struct{}, 1),
	}
}

// Start 加载启用中的定时定义并启动；每 60s 与数据库同步一次。
func (s *Scheduler) Start(ctx context.Context) {
	s.Reload()
	s.cron.Start()
	go func() {
		t := time.NewTicker(60 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				s.cron.Stop()
				return
			case <-t.C:
				s.Reload()
			}
		}
	}()
}

// Reload 根据数据库中的定时定义重建 cron 任务。
func (s *Scheduler) Reload() {
	select {
	case s.mu <- struct{}{}:
	default:
		return // 上一次重载进行中
	}
	defer func() { <-s.mu }()

	entries := s.cron.Entries()
	for _, e := range entries {
		if _, ok := e.Job.(*scheduleJob); ok {
			s.cron.Remove(e.ID)
		}
	}

	list, err := s.st.ListScheduledTasks()
	if err != nil {
		log.Printf("调度器加载失败: %v", err)
		return
	}
	for _, tk := range list {
		if !tk.Enabled {
			continue
		}
		tk := tk
		_, err := s.cron.AddJob(tk.Cron, &scheduleJob{s: s, tk: &tk})
		if err != nil {
			log.Printf("定时任务 %s 表达式非法（%s）: %v", tk.Title, tk.Cron, err)
		}
	}
}

type scheduleJob struct {
	s  *Scheduler
	tk *store.Task
}

// Run 按定时定义的形态实例化；每次触发创建一个新实例。
func (j *scheduleJob) Run() {
	tk := j.tk
	now := store.Now()
	fired := false
	switch tk.Type {
	case store.TaskTypeTask:
		fired = j.dispatchTask(now)
	case store.TaskTypeSession:
		fired = j.dispatchSession(now)
	case store.TaskTypeWorkflow:
		fired = j.dispatchWorkflow(now)
	default:
		log.Printf("定时任务 %s 形态非法（%s），跳过", tk.Title, tk.Type)
		return
	}
	if fired {
		if err := j.s.st.UpdateTask(tk.ID, map[string]any{"last_run_at": now}); err != nil {
			log.Printf("定时任务 %d 更新 last_run_at 失败: %v", tk.ID, err)
		}
	}
}

// dispatchTask 渲染 title/body 模板并创建任务实例（与旧 Schedule 语义一致）。
func (j *scheduleJob) dispatchTask(now string) bool {
	tk := j.tk
	title, err := renderTemplate(tk.Title, tk.Title)
	if err != nil {
		title = tk.Title
	}
	body, err := renderTemplate(tk.Body, tk.Title)
	if err != nil {
		body = tk.Body
	}
	agent, err := j.s.st.GetRole(*tk.RoleID)
	if err != nil {
		log.Printf("定时任务 %s 的角色不存在，跳过", tk.Title)
		return false
	}
	instance := store.Task{
		Title: title, Body: body, Status: store.StatusQueued,
		Perm: tk.Perm, RunMode: store.RunModeBatch, RoleID: &agent.ID,
		ProjectID: tk.ProjectID, DependencyMode: store.DependencyNone, BlockOnFailure: tk.BlockOnFailure,
		ScheduleID: &tk.ID, CreatedAt: now, UpdatedAt: now,
	}
	if tk.ProjectID != nil {
		project, err := j.s.st.GetProject(*tk.ProjectID)
		if err != nil {
			// 正常删除项目会由外键把 project_id 置空；这里仍保留
			// 防御性检查，避免一个过期调度进入无法解释的项目依赖链。
			log.Printf("定时任务 %s 的项目不存在，跳过: %v", tk.Title, err)
			return false
		}
		instance.ProjectDir = project.ProjectDir
		// 项目定时实例只是“按时创建的新任务”；真正的执行仍按该项目
		// 的项目执行顺序弱依赖链排队，且完成后必须先走自己的合并子任务。
		instance.DependencyMode = store.DependencyWeak
	}
	id, err := j.s.st.CreateTaskWithProjectDependency(instance)
	if err != nil {
		log.Printf("定时任务 %s 创建任务失败: %v", tk.Title, err)
		return false
	}
	j.s.ex.Wake()
	createdTask, err := j.s.st.GetTask(id)
	if err == nil {
		j.s.hub.Publish(events.Event{Type: "task", TaskID: id, Payload: createdTask})
	}
	log.Printf("定时任务 %s 已派发任务 #%d", tk.Title, id)
	return true
}

// dispatchSession 创建会话实例并自动启动、发送初始指令（body 为模板渲染后的 seed）。
func (j *scheduleJob) dispatchSession(now string) bool {
	tk := j.tk
	if tk.ProjectID == nil {
		log.Printf("定时会话 %s 未关联项目，跳过", tk.Title)
		return false
	}
	title, _ := renderTemplate(tk.Title, tk.Title)
	seed, _ := renderTemplate(tk.Body, tk.Title)
	ss, err := j.s.sess.Create(tk.ProjectID, *tk.RoleID, tk.Perm)
	if err != nil {
		log.Printf("定时会话 %s 创建失败: %v", tk.Title, err)
		return false
	}
	set := map[string]any{"title": title, "schedule_id": tk.ID, "updated_at": now}
	if seed != "" {
		set["body"] = seed
	}
	if err := j.s.st.UpdateTask(ss.ID, set); err != nil {
		log.Printf("定时会话 %s 更新失败: %v", tk.Title, err)
		return false
	}
	if err := j.s.sess.Start(context.Background(), ss.ID); err != nil {
		log.Printf("定时会话 %s 启动失败: %v", tk.Title, err)
		return false
	}
	if seed != "" {
		if _, err := j.s.sess.Prompt(context.Background(), ss.ID, seed, nil, "follow_up"); err != nil {
			log.Printf("定时会话 %s 发送初始指令失败: %v", tk.Title, err)
		}
	}
	log.Printf("定时会话 %s 已创建会话 #%d", tk.Title, ss.ID)
	return true
}

// dispatchWorkflow 从工作流定义启动一次 Run（不可用或未绑定项目则跳过并提示）。
// 定义标题作为本次触发的自定义任务（渲染 {{.date}} 等变量，与定时任务
// 的标题/正文模板一致）：节点意图里的 {{.task}} 拿到触发时上下文，纯文本
// 意图自动附加，Run 书签记录每次触发的内容。
func (j *scheduleJob) dispatchWorkflow(now string) bool {
	tk := j.tk
	if tk.Status != workflow.WorkflowStatusAdopted {
		log.Printf("定时工作流 %s 定义不可用（status=%s），跳过本次触发", tk.Title, tk.Status)
		return false
	}
	if tk.ProjectID == nil {
		log.Printf("定时工作流 %s 未绑定目标项目，跳过本次触发", tk.Title)
		return false
	}
	task, _ := renderTemplate(tk.Title, tk.Title)
	run, err := j.s.wf.StartPlan(tk.ID, tk.Revision, *tk.ProjectID, task)
	if err != nil {
		log.Printf("定时工作流 %s 启动 Run 失败: %v", tk.Title, err)
		return false
	}
	log.Printf("定时工作流 %s 已启动 Run #%d", tk.Title, run.ID)
	return true
}

// renderTemplate 渲染 {{.date}} 等变量；非法模板降级为原文。
func renderTemplate(src, name string) (string, error) {
	if !strings.Contains(src, "{{") {
		return src, nil
	}
	t, err := template.New("sched").Parse(src)
	if err != nil {
		return "", err
	}
	var sb strings.Builder
	data := map[string]string{
		"date": time.Now().Format("2006-01-02"),
		"time": time.Now().Format("2006-01-02 15:04"),
		"name": name,
	}
	if err := t.Execute(&sb, data); err != nil {
		return "", err
	}
	return sb.String(), nil
}
