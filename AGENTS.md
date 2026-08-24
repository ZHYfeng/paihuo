## Agent skills

### Issue tracker

Issues 在 GitHub Issues（ZHYfeng/paihuo），用 `gh` CLI 操作。见 `docs/agents/issue-tracker.md`。

### Triage labels

五个标准 triage 角色用默认标签名（`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`）。见 `docs/agents/triage-labels.md`。

### Domain docs

Single-context：根目录 `CONTEXT.md` + `docs/adr/`。见 `docs/agents/domain.md`。

文档职责：

- `CONTEXT.md` 是领域语言的唯一权威；术语、实体和边界冲突时以它为准。
- `docs/adr/` 记录已接受并生效的架构决策及其推导，不作为第二份领域词汇表。
- `docs/design/` 只保存仍需持续阅读的实现设计与流程说明，不得覆盖 `CONTEXT.md` 或已接受 ADR。