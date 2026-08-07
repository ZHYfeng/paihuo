package exec

import (
	"strings"

	"paihuo/internal/store"
)

// AppendSystemPrompt 在保留已有角色系统提示词的前提下追加一段运行时上下文。
// 技能名称等角色元数据属于 system prompt，不应混入用户任务指令。
func AppendSystemPrompt(base, addition string) string {
	base = strings.TrimSpace(base)
	addition = strings.TrimSpace(addition)
	switch {
	case base == "":
		return addition
	case addition == "":
		return base
	default:
		return base + "\n\n" + addition
	}
}

// taskPrompt 将用户填写的任务标题与正文一起交给 agent。标题是必填的最小
// 指令，正文是可选的补充说明；两者都不能在执行时悄悄丢失。
func taskPrompt(tk store.Task) string {
	title := strings.TrimSpace(tk.Title)
	body := strings.TrimSpace(tk.Body)
	switch {
	case title == "":
		return body
	case body == "":
		return title
	default:
		return "任务标题：" + title + "\n\n任务内容：\n" + body
	}
}
