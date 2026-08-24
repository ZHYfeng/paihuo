package store

import (
	"strings"
	"testing"
)

// 停用的角色不应出现在可派发队列里。
func TestListQueuedTasksSkipsDisabledRoles(t *testing.T) {
	s := openTest(t)
	on := mustRole(t, s, "on", true)
	off := mustRole(t, s, "off", false)
	mustTask(t, s, "t1", &on, StatusQueued, "")
	mustTask(t, s, "t2", &off, StatusQueued, "")

	tasks, err := s.ListQueuedTasks()
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 1 || tasks[0].Title != "t1" {
		t.Fatalf("期望只有启用角色的排队任务，得到 %+v", tasks)
	}
}

// 列表接口 body 截断到 400 字符，详情接口保持完整。
func TestListBodyTruncatedDetailFull(t *testing.T) {
	s := openTest(t)
	a := mustRole(t, s, "a", true)
	body := strings.Repeat("长提示词", 200) // 800 个字符
	id := mustTask(t, s, "t", &a, StatusQueued, body)

	tasks, err := s.ListTasks()
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 1 || len([]rune(tasks[0].Body)) != 400 {
		t.Fatalf("列表 body 应截断为 400 字符，得到 %d", len([]rune(tasks[0].Body)))
	}
	tk, err := s.GetTask(id)
	if err != nil || len([]rune(tk.Body)) != len([]rune(body)) {
		t.Fatalf("详情 body 应保持完整: %d err=%v", len([]rune(tk.Body)), err)
	}
}
