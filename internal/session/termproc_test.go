package session

import (
	"testing"
	"time"
)

// TestIsCodexTrustPrompt 验证信任确认画面的识别：
// 命中 codex 专属文案、不命中正常 TUI/其他 CLI 画面。
func TestIsCodexTrustPrompt(t *testing.T) {
	trust := `> You are in /tmp/session-1

  Do you trust the contents of this directory? Working with untrusted contents
  comes with higher risk of prompt injection. Trusting the directory allows
  project-local config, hooks, and exec policies to load.

› 1. Yes, continue
  2. No, quit

  Press enter to continue`
	if !isCodexTrustPrompt(trust) {
		t.Fatal("信任确认画面未被识别")
	}

	// 正常 codex TUI（已信任/已确认后的画面）。
	normal := `╭───────────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.147.0)                        │
│ model:       gpt-5.6-sol xhigh   /model to change │
│ permissions: YOLO mode                            │
╰───────────────────────────────────────────────────╯
› `
	if isCodexTrustPrompt(normal) {
		t.Fatal("正常 TUI 画面被误判为信任确认")
	}

	// 只出现一半文案（如选项未渲染完整）不触发。
	half := "Do you trust the contents of this directory?\n2. No, quit"
	if isCodexTrustPrompt(half) {
		t.Fatal("缺失选项行的画面不应触发")
	}

	// 其它 CLI（claude 等）画面不触发。
	claude := "Claude Code 1.0.0\n> "
	if isCodexTrustPrompt(claude) {
		t.Fatal("其它 CLI 画面被误判")
	}

	// 空画面不触发。
	if isCodexTrustPrompt("") {
		t.Fatal("空画面不应触发")
	}
}

// TestAutoConfirmTrustWindowGone 验证窗口消失时后台确认协程立即退出
// （tmux socket 不存在 → capture 失败 → return，不泄漏 goroutine）。
func TestAutoConfirmTrustWindowGone(t *testing.T) {
	p := newTermProc("no-such-socket")
	done := make(chan struct{})
	go func() {
		p.autoConfirmTrust("session-0")
		close(done)
	}()
	select {
	case <-done:
		// 正常退出
	case <-time.After(10 * time.Second):
		t.Fatal("autoConfirmTrust 在窗口缺失时未及时退出")
	}
}
