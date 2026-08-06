# Changelog

This file records notable user-facing and maintainer-facing changes. The format follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are added when releases are tagged.

## Unreleased

### Added

- Reproducible frontend tooling through `package.json` and `package-lock.json`.
- `make` targets for build, test, race detection, frontend synchronization, and the full quality gate.
- GitHub CI, CodeQL, Dependabot, issue forms, and a pull-request checklist.
- Contribution, support, security, and community conduct documentation.
- `--version` and `--secure-cookie` runtime flags.

### Changed

- 角色技能物化重构：技能改为**角色级常驻挂载**（`<sessionsRoot>/.role-agents/<agentID>/`，symlink 零复制 + 幂等对账），不再逐任务复制到 worktree/项目目录——结构性消灭 git 提交污染与目录污染，崩溃/重启自动对账恢复
- 各 CLI 技能加载方式：pi `--skill` 逐目录、omp `--config overlay.yml`（自动合并全局 `customDirectories`）、opencode 注入 `OPENCODE_CONFIG_CONTENT`（弃用无效的 `--config` 字段；与项目 `opencode.json` 的 `skills.paths` 深合并已实测）、claude `--plugin-dir`、codex 任务级 symlink 到 `$CODEX_HOME/skills`（未设置时回退 `$HOME/.agents/skills`；只被 codex 扫描，不污染 pi/omp 上下文，结束即删，manifest 兜底）
- 非 git 项目 + codex（safe 模式）自动注入 `--skip-git-repo-check`，不再依赖 yolo 或临时 git init（角色工作台同步切换）
- 角色技能变更保存后立即对账；角色删除后技能目录进 `.stale` 保留 7 天；启动时一次性清理旧机制残留在 worktree 的 `paihuo-*` 副本（仅该前缀，不碰用户技能）
- 技能 frontmatter `name` 与目录名不一致/非法时回退为副本并改写 name；缺 description 仅告警（omp 下不可见）；任务提示词技能名与各 CLI 实际可见名统一（codex 按 frontmatter name/目标目录名显示，已实测）

- The default listen address is now `127.0.0.1:8080`; binding a non-loopback address without an access token is rejected.
- Session cookies use a cryptographically random nonce and complete HMAC signature.
- HTTP responses include a browser-security baseline, dynamic responses are not cached, and JSON request bodies are bounded and strictly parsed.
