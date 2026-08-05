package exec

import (
	"strings"

	"paihuo/internal/store"
)

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
