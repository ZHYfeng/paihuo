package workflow

import (
	"strings"
	"text/template"
	"time"
)

// RenderIntent 把节点意图渲染为本次 Run 的实际任务指令，实现「固定工作流 +
// 自定义任务」：工作流定义是可复用模板，启动 Run 时提供具体任务，节点 agent
// 都拿到本次任务上下文。
//
// 规则（确定性、可审计）：
//   - 意图含模板占位符（{{）时，由作者完全控制：渲染 {{.task}} / {{.date}} /
//     {{.time}}；模板语法错误降级为原文（与定时渲染一致）。
//   - 意图是纯文本（不含 {{）时，task 非空则自动附加「自定义任务：…」，保证
//     未模板化的固定工作流也能感知每次 Run 的具体任务；task 为空则原文返回。
func RenderIntent(intent, task string) string {
	task = strings.TrimSpace(task)
	if !strings.Contains(intent, "{{") {
		if task == "" {
			return intent
		}
		return intent + "\n\n自定义任务：" + task
	}
	tmpl, err := template.New("intent").Parse(intent)
	if err != nil {
		return intent
	}
	var sb strings.Builder
	if err := tmpl.Execute(&sb, map[string]string{
		"task": task,
		"date": time.Now().Format("2006-01-02"),
		"time": time.Now().Format("2006-01-02 15:04"),
	}); err != nil {
		return intent
	}
	return sb.String()
}
