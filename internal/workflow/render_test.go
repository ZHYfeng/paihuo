package workflow

import (
	"strings"
	"testing"
)

func TestRenderIntent(t *testing.T) {
	cases := []struct {
		name   string
		intent string
		task   string
		want   string // "" 表示走自定义断言
		check  func(t *testing.T, got string)
	}{
		{
			name:   "纯文本意图 + 自定义任务自动附加",
			intent: "实现目标并运行相关检查",
			task:   "修复登录页 XSS",
			want:   "实现目标并运行相关检查\n\n自定义任务：修复登录页 XSS",
		},
		{
			name:   "无任务保持原文",
			intent: "实现目标并运行相关检查",
			task:   "",
			want:   "实现目标并运行相关检查",
		},
		{
			name:   "空白任务视为无任务",
			intent: "构建",
			task:   "  \n ",
			want:   "构建",
		},
		{
			name:   "{{.task}} 占位符替换",
			intent: "针对任务「{{.task}}」实现并验证",
			task:   "修复登录页 XSS",
			want:   "针对任务「修复登录页 XSS」实现并验证",
		},
		{
			name:   "模板化意图不重复附加",
			intent: "针对 {{.task}} 复核",
			task:   "修复登录页 XSS",
			want:   "针对 修复登录页 XSS 复核",
		},
		{
			name:   "含其他占位符的意图由作者控制",
			intent: "每日例行检查（{{.date}}）",
			task:   "修复登录页 XSS",
			check: func(t *testing.T, got string) {
				if !strings.HasPrefix(got, "每日例行检查（") || !strings.Contains(got, "）") {
					t.Fatalf("date 模板应渲染: %q", got)
				}
				if strings.Contains(got, "自定义任务") {
					t.Fatalf("模板化意图不应自动附加任务: %q", got)
				}
			},
		},
		{
			name:   "非法模板降级为原文",
			intent: "坏模板 {{.task",
			task:   "修复登录页 XSS",
			want:   "坏模板 {{.task",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := RenderIntent(tc.intent, tc.task)
			if tc.check != nil {
				tc.check(t, got)
				return
			}
			if got != tc.want {
				t.Fatalf("RenderIntent(%q, %q) = %q, want %q", tc.intent, tc.task, got, tc.want)
			}
		})
	}
}
