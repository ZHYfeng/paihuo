// Package sched 实现定时任务调度：cron 触发 → 模板渲染 → 创建任务。
package sched

import (
	"context"
	"log"
	"strings"
	"text/template"
	"time"

	"github.com/robfig/cron/v3"

	"paihuo/internal/events"
	"paihuo/internal/exec"
	"paihuo/internal/store"
)

type Scheduler struct {
	st      *store.Store
	hub     *events.Hub
	ex      *exec.Executor
	cron    *cron.Cron
	mu      chan struct{} // 串行化重载
	stopped bool
}

func New(st *store.Store, hub *events.Hub, ex *exec.Executor) *Scheduler {
	return &Scheduler{
		st:   st,
		hub:  hub,
		ex:   ex,
		cron: cron.New(cron.WithSeconds(), cron.WithLocation(time.Local)),
		mu:   make(chan struct{}, 1),
	}
}

// Start 加载启用中的定时任务并启动；每 60s 与数据库同步一次。
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

// Reload 根据数据库中的 schedules 重建 cron 任务。
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

	list, err := s.st.ListSchedules()
	if err != nil {
		log.Printf("调度器加载失败: %v", err)
		return
	}
	for _, sc := range list {
		if !sc.Enabled {
			continue
		}
		sc := sc
		_, err := s.cron.AddJob(sc.Cron, &scheduleJob{s: s, sc: &sc})
		if err != nil {
			log.Printf("定时任务 %s 表达式非法（%s）: %v", sc.Name, sc.Cron, err)
		}
	}
}

type scheduleJob struct {
	s  *Scheduler
	sc *store.Schedule
}

func (j *scheduleJob) Run() {
	sc := j.sc
	title, err := renderTemplate(sc.TitleTemplate, sc.Name)
	if err != nil {
		title = sc.TitleTemplate
	}
	body, err := renderTemplate(sc.BodyTemplate, sc.Name)
	if err != nil {
		body = sc.BodyTemplate
	}
	agent, err := j.s.st.GetAgent(sc.AgentID)
	if err != nil {
		log.Printf("定时任务 %s 的角色不存在，跳过", sc.Name)
		return
	}
	now := store.Now()
	id, err := j.s.st.CreateTask(store.Task{
		Title: title, Body: body, Status: store.StatusQueued,
		Perm: agent.DefaultPerm, AgentID: &agent.ID, ProjectDir: agent.ProjectDir,
		ScheduleID: &sc.ID, CreatedAt: now, UpdatedAt: now,
	})
	if err != nil {
		log.Printf("定时任务 %s 创建任务失败: %v", sc.Name, err)
		return
	}
	_ = j.s.st.UpdateSchedule(sc.ID, map[string]any{"last_run_at": now})
	j.s.ex.Wake()
	tk, err := j.s.st.GetTask(id)
	if err == nil {
		j.s.hub.Publish(events.Event{Type: "task", TaskID: id, Payload: tk})
	}
	log.Printf("定时任务 %s 已派发任务 #%d", sc.Name, id)
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
