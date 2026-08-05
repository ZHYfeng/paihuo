package exec

import (
	"strings"
	"testing"

	"paihuo/internal/store"
)

func TestTaskPromptIncludesTitleAndBody(t *testing.T) {
	tk := store.Task{Title: "修复看板", Body: "新增项目入口。\n\n保持现有样式。"}
	want := "任务标题：修复看板\n\n任务内容：\n新增项目入口。\n\n保持现有样式。"
	if got := taskPrompt(tk); got != want {
		t.Fatalf("任务提示词不完整:\n got: %q\nwant: %q", got, want)
	}
}

func TestTaskPromptUsesTitleWhenBodyBlank(t *testing.T) {
	got := taskPrompt(store.Task{Title: "只填标题也要执行", Body: " \n\t "})
	if got != "只填标题也要执行" {
		t.Fatalf("空正文时应使用标题，得到 %q", got)
	}
}

func TestCodexYoloAdapterBuild(t *testing.T) {
	a := &codexAdapter{baseAdapter{id: "codex", name: "Codex", bin: "codex"}}
	_, args, _, err := a.Build(RunOptions{
		Prompt: "完成任务",
		Role:   store.RoleConfig{Custom: map[string]string{"execution_mode": "yolo"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	for _, want := range []string{"exec", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "完成任务"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("Codex YOLO 缺少参数 %q: %s", want, joined)
		}
	}

	_, safeArgs, _, err := a.Build(RunOptions{Prompt: "完成任务"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(safeArgs, " "), "dangerously-bypass") {
		t.Fatalf("safe 模式不应隐式启用 YOLO: %s", strings.Join(safeArgs, " "))
	}
}

func TestCodexSchemaExposesYoloMode(t *testing.T) {
	a := &codexAdapter{baseAdapter{id: "codex", name: "Codex", bin: "codex"}}
	for _, field := range a.Schema() {
		if field.Key == "execution_mode" {
			if field.Default != "safe" || len(field.Options) != 2 || field.Options[1] != "yolo" {
				t.Fatalf("Codex YOLO schema 异常: %+v", field)
			}
			return
		}
	}
	t.Fatal("Codex schema 缺少 execution_mode")
}
