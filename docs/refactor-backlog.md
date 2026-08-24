# PaiHuo 代码库体检与改造清单

> 体检日期：2026-08-24（对应提交 `ccc246c`，工作区含未提交的编排者会话改动）
> 目的：搞清楚「每次改动要读很多文件、跑很多门禁」的具体来源，给出一份可以逐项派活的改造清单。
> 状态：**只做诊断和规划，未执行任何改动。**

---

## 0. 怎么读这份文档

- **第 1 节**讲结论：混乱到底来自哪里。如果你只有五分钟，读这一节。
- **第 2 节**是体检数据：每个数字怎么来的、用什么命令能复现。做决策时用来对账。
- **第 3 节**是 19 项改造任务。每项写清了「现在是什么样、为什么是问题、要做什么、怎么算做完」。
- **第 4 节**讲这些任务之间的关系：哪些能并行、哪些会撞车、先做哪三个。

每项任务都是**范围独立**的：单独开分支、单独合入、单独验收，不需要等别的任务先完成。
但有几项会改同一个文件，同时开分支会有合并冲突——第 4 节列了具体是哪几组。

---

## 1. 结论：混乱来自三个地方

项目本身的架构方向是清楚的——Go 单二进制 + SQLite + tmux + Git worktree，
`CONTEXT.md` 里的领域语言（Task 是唯一实体，四种形态只是创建方式差异）定义得也很扎实。
真正让日常改动变重的，不是架构，是下面三件很具体的事。

### 1.1 同一个字段要在四张手写清单里各写一遍，而且没人比对它们

给 `Task` 加一个字段，比如上次加 `merge_skipped`，你要改这些地方：

| # | 位置 | 干什么 |
|---|---|---|
| 1 | `internal/store/store.go` 的 `schema` 常量 | 加建表列 |
| 2 | `internal/store/store.go` 的 `migrateXxx` | 给存量库补列 |
| 3 | `internal/store/models.go` 的 `Task` struct | 加 Go 字段和 json tag |
| 4 | `internal/store/store.go` 的 `taskCols` | 加到第一份 52 列 SELECT 清单 |
| 5 | `internal/store/store.go` 的 `taskColsBrief` | 加到第二份 52 列 SELECT 清单（同样位置！） |
| 6 | `internal/store/store.go` 的 `scanTask` | 加到 52 个参数的 `rows.Scan(...)`（同样位置！） |
| 7 | `internal/server/handlers.go` 的 `patchTask` | 如果可编辑，加进字段白名单 |
| 8 | `internal/server/openapi.yaml` | 加进 API 契约 |
| 9 | `frontend/src/types.ts` | 加进 TypeScript 的 `Task` 接口 |
| 10 | `frontend/src/lib/taskmeta.ts` | 如果要显示，加展示逻辑 |

第 4、5、6 项特别恶心：`taskCols`、`taskColsBrief`、`scanTask` 三者的**顺序必须逐位对齐**，
少一列、多一列、顺序错一位，编译器一句话都不会说，只在运行时报一个
`sql: expected 52 destination arguments in Scan, not 51` 或者更糟——类型碰巧兼容，值静默错位。

第 8、9 项完全没有守卫。`openapi.yaml` 的守卫测试只检查 9 个字符串是否出现过；
`types.ts` 是纯手抄，漏抄的字段在浏览器里就是 `undefined`。

**这就是「改一处要读很多文件」的主要来源。** 不是文件多，是同一个事实被复制了四份，
你必须把四份都找出来才敢改。

### 1.2 编译产物进了 git，于是每次改前端都要付两遍钱

`internal/web/dist/` 下 15 个带 hash 的构建产物是**入库的**，因为 Go 用 `go:embed` 把它们
打进单二进制。这个设计本身合理（生产环境不跑 Node），但产物入库带来两笔开销：

**第一笔，diff 噪声。** Vite 每次构建都会改文件名 hash，所以任何前端改动都会产生一批
「删一个 + 加一个」的二进制 diff：

```
ccc246c  20 个变更文件，其中 14 个是 dist 产物
0f7b5b5  44 个变更文件，其中 22 个是 dist 产物
```

代码 review 时要在这堆噪声里翻真正的改动。

**第二笔，门禁重复构建。** 为了防止「改了前端但忘了提交产物」，
`scripts/build-frontend.sh --check` 会**再跑一次完整 Vite 构建**到临时目录，
然后逐文件 diff——还得先用 `sed` 抹掉行尾空白才比得平。
于是 `make check` 里 Vite 跑了两次，而这一整套机制存在的唯一理由，就是产物入库了。

### 1.3 巨型文件 + 复制粘贴的样板

```
internal/store/store.go        3536 行   schema + 8 个迁移 + 9 类实体的全部 SQL
internal/server/handlers.go    2256 行   70 个函数，9 类职责混装
internal/server/handlers.go:265  patchTask 单函数约 280 行，叠了 6 件事
frontend/src/pages/tasks.tsx    931 行   30 个 useState，46 处 query/mutation
```

改任务依赖要在 `store.go` 里滚到 1900 行，改统计要滚到 3000 行。

复制粘贴的典型是 server 包的测试：12 个 `_test.go` 各自抄了同一段六行 bootstrap

```go
st, _ := store.Open(":memory:")
hub := events.New(st)
executor := exec.New(st, hub, ...)
wf := application.NewWorkflowService(...)
sess := session.New(st, hub, executor, ...)
sc := sched.New(st, hub, executor, sess, wf)
s := New(st, hub, executor, sc, sess, wf, "", skillsDir)   // 8 个参数
```

给 `server.New` 加一个依赖，就要改 13 处（1 个定义 + 12 个测试）。

### 1.4 一个反直觉的发现：门禁的耗时其实不是问题

实测下来：

```
go test ./cmd/... ./internal/...      16.8s   （internal/exec 独占 16.0s）
npm run typecheck                      1.2s
npm run lint                           5.6s
./scripts/build-frontend.sh --check    1.4s
npm test                               1.6s
```

全套 `make check` 大概半分钟。所以**「跑很多门禁」的痛感不来自等待时间，
来自步骤数和心智负担**：改一行 Go handler 也要跑 eslint 和 Vitest，
改一行 TSX 就要记得重新 build 并提交产物，否则门禁红。

这一点影响了任务优先级：`GATE-1`、`GATE-2` 的价值主要在「减少你要记住的规矩」，
而不是「让 CI 快几秒」。真正省时间的只有 `GATE-3`（两个用例各真睡 4 秒）。

---

## 2. 体检数据

所有数字都可以用下面的命令复现。

### 2.1 规模

```bash
find . -name '*.go' -not -path './node_modules/*' | xargs wc -l | tail -1
# 32852 行 Go 代码

git ls-files | wc -l
# 186 个跟踪文件，其中 15 个是 internal/web/dist 下的构建产物
```

单文件 Top 8：

| 行数 | 文件 | 说明 |
|---:|---|---|
| 3536 | `internal/store/store.go` | schema + 迁移 + 全部实体的 SQL |
| 2256 | `internal/server/handlers.go` | 70 个 HTTP handler，9 类职责 |
| 1374 | `internal/store/store_test.go` | 对应上面那个巨型文件的测试 |
| 1232 | `internal/exec/executor.go` | 任务调度与 tmux 生命周期 |
| 1200 | `internal/exec/models.go` | 6 个 CLI 的模型探测 |
| 1132 | `internal/exec/skills.go` | 技能目录挂载 |
| 1083 | `internal/exec/tmux.go` | tmux 封装 |
| 1040 | `internal/session/manager.go` | 会话生命周期 |

### 2.2 API 契约漂移

```bash
grep -ohE '"(GET|POST|PATCH|PUT|DELETE) /api/v1[^"]*"' internal/server/*.go | sort -u | wc -l
# 58 条已注册路由

grep -cE '^  /' internal/server/openapi.yaml
# 34 条 OpenAPI path
```

完全没写进契约的有：`/skills/*`、`/extensions/*`、`/fs/*`、`/stats/*`、
`/workspace/*`、`/role-studio/*`、`/mcp`、`/tasks/{id}/children`、`/tasks/cleanup`。

守卫测试 `openapi_test.go` 的全部内容是断言 9 个字符串在 yaml 里出现过——
它永远抓不到「新加了路由但没写契约」。

### 2.3 分层采纳率

```bash
grep -o "s\.st\.[A-Za-z]*" internal/server/*.go | grep -v _test | wc -l
# 107 处 handler 直接调 store

grep -o "s\.\(tasks\|workflows\|workspaces\)\.[A-Za-z]*" internal/server/*.go | grep -v _test | wc -l
# 17 处走 application 层
```

`internal/application` 只覆盖了「任务创建」「工作流」「工作副本」三块。
任务的状态流转（审批、驳回、取消、恢复、级联删除）全在 handler 里。
结果是多了一层但没减耦合：读一条业务规则要同时看两个包。

### 2.4 测试样板

```bash
grep -l "sched.New(st" internal/server/*_test.go | wc -l
# 12
```

### 2.5 慢测试

```bash
go test ./internal/exec -count=1 -v 2>&1 | grep -E '^--- PASS' | sort -t'(' -k2 -rn | head -3
```

| 耗时 | 用例 |
|---:|---|
| 4.01s | `TestExecutorWaitForDelayedDetachedExitCodeAfterConfirmedAgentEnd` |
| 4.01s | `TestExecutorKeepWatchingUnknownDetachedAgentWithOutputHeartbeat` |
| 1.94s | `TestCreateInteractiveTaskOnlySupportsInteractiveRuntime` |

前两个是真实 `time.Sleep`，等的是 `waitTmux` 里写死的心跳间隔和退出确认窗口。

### 2.6 死代码

`internal/visualization` 整包（`spec.go` 76 行 + 测试）**没有任何 Go 导入方**：

```bash
grep -rn "visualization" internal --include=*.go | grep -v "^internal/visualization"
# 无输出
```

前端 `pages/workflows.tsx` 里的 `TaskGraph` 用的是自己定义的类型，和这个包无关。

三个导出函数全仓零调用：

- `internal/github/gh.go:113` `Client.CreatePullRequest`
- `internal/exec/runtime_service.go:135` `RuntimeService.RegisterSession`
- `internal/store/store.go:2963` `Store.UpdateProject` — 项目更新实际走 `UpdateAtRevision`

### 2.7 仓库里不该有的文件

已入库（`git ls-files` 能查到）：

| 文件 | 是什么 |
|---|---|
| `c.txt` | **curl 生成的 cookie jar，含一条真实 `paihuo_session` 会话值** |
| `sse.log` | 19 KB SSE 调试输出 |
| `all_cmds.txt` | 一份别处的命令名单，和本项目无关 |
| `role-shot.tmp.cjs` | 一次性截图脚本，硬编码了 `/home/yu/Agents/paihuo` 绝对路径 |

未入库但躺在工作目录：`paihuo.db.bak.1786850981`（172 KB）、空的 `artifacts/`。

`c.txt` 随提交 `69bbb15` 进入 git 历史。删文件解决不了——**那个 token 需要轮换**。

### 2.8 文档与代码不一致

- `internal/store/store.go` 顶部注释写着「当前 schema 是唯一受支持的数据库形态；
  不包含历史迁移路径。唯一例外：`workflow_runs.project_id`……」
  但文件里实际有 **8 个** `migrateXxx` 补列函数，`Open` 里逐个执行。
- `docs/TECHNOLOGY_EVOLUTION.md` 把「OpenAPI 3.1」列为 API 层现状，实际覆盖率 34/58。
- `docs/design/task-unification.md` 标注「设计定稿」且已经落地，内容与 `CONTEXT.md` 的
  Task 段落大面积重复，读的人不知道哪份是权威。

### 2.9 重复路由与命名不一致

```go
m.HandleFunc("PUT   /api/v1/projects/{id}/tasks/order", s.reorderProjectTasks)
m.HandleFunc("PATCH /api/v1/projects/{id}/tasks/order", s.reorderProjectTasks)  // 同一个 handler
```

```go
m.HandleFunc("GET /api/v1/stats/roles/{id}",   s.roleStats)     // 复数
m.HandleFunc("GET /api/v1/stats/project/{id}", s.projectStats)  // 单数
```

---

## 3. 改造清单

19 项，按「拿到就能做」到「需要单独排期」排列。**顺序不代表依赖。**

任务 ID 的前缀表示领域，不表示先后：
`JUNK` 清理 / `DEAD` 死代码 / `DOC` 文档 / `GATE` 门禁 / `TEST` 测试 /
`HTTP` 传输层 / `STORE` 存储层 / `RT` 运行时 / `FE` 前端 / `API` 契约 /
`ARCH` 分层 / `TYPE` 类型 / `MODEL` 数据模型 / `MIG` 迁移

---

### 一、清理（3 项，当天可完成）

零行为变更。最先做掉，能让后面每一项的 diff 都干净。

---

#### JUNK-1 · 清掉根目录临时文件，并轮换泄漏的会话令牌

**工作量**：0.5 天

**现状**

根目录有四个已入库的临时文件（见 2.7）。其中 `c.txt` 里是一条真实的
`paihuo_session` cookie，格式是 `<过期时间戳>.<签名>`，已经随 `69bbb15` 进了 git 历史。
即使现在删掉文件，历史里仍然有；这个 token 只要没过期就仍然能登录本机实例。

`role-shot.tmp.cjs` 是一个用 Playwright 截图的一次性脚本，
里面写死了 `/home/yu/Agents/paihuo/node_modules/playwright` 和 token `'t'`，
在别人机器上跑不了。

**做什么**

1. `git rm c.txt sse.log all_cmds.txt role-shot.tmp.cjs`
2. `.gitignore` 补上 `*.log`、`*.tmp.*`、`c.txt` 这类 cookie jar 的模式
3. `role-shot.tmp.cjs` 里如果有值得留的截图逻辑，并进 `scripts/e2e.js`；否则直接丢
4. 清掉工作目录的 `paihuo.db.bak.1786850981` 和空的 `artifacts/`
5. **轮换本机 PaiHuo token**（改 `PAIHUO_TOKEN` 或对应 setting，重启服务）

**怎么算做完**

- `git ls-files` 不再命中这四个文件
- 全仓 `grep -rn paihuo_session` 只命中源码里的 cookie 名常量
- 用 `c.txt` 里那个旧 token 请求 `/api/v1/tasks` 返回 401

**触及**：`c.txt`、`sse.log`、`all_cmds.txt`、`role-shot.tmp.cjs`、`.gitignore`

---

#### DEAD-1 · 删除无调用方的包与导出函数

**工作量**：0.5 天

**现状**

`internal/visualization` 是一个可视化 spec 校验器（拒绝 `html`/`script`/`url`/`on*` 字段），
设计意图很清楚——不让 Role 产出的 HTML/JS 进入前端渲染。
但它没有任何 Go 导入方，也就是说这道安全闸门**从来没有被接上**。
前端的 `TaskGraph` 走的是另一套类型，和它无关。

另外三个导出函数零调用（见 2.6）。

**做什么**

删包、删函数。

`internal/visualization` 需要先做个判断：如果它是为「Role 产出可视化产物」这个未来能力预留的，
那就补上调用方（比如在 artifact 入库时校验），或者写进设计文档说明留存理由。
**不要留一个没有出口的验证器**——它给人一种「这里有防护」的错觉。

**怎么算做完**

- `go build ./... && go test ./...` 全绿
- 仓库少一个包、三个函数

**触及**：`internal/visualization/`、`internal/github/gh.go`、
`internal/exec/runtime_service.go`、`internal/store/store.go`

---

#### DOC-1 · 文档去重与勘误

**工作量**：0.5 天

**现状**

三处文档与代码不符或彼此重复（见 2.8）。最误导人的是 `store.go` 顶部那段注释——
它让读代码的人以为「不支持存量库升级」，而实际上有 8 个补列函数在默默工作。
下一个人要加字段时，会不知道该不该写迁移。

**做什么**

1. `docs/design/task-unification.md` 已经落地，移进 `docs/adr/` 并标注生效日期；
   保留设计推导过程作为历史记录，但明确 `CONTEXT.md` 是领域语言的唯一权威
2. 改写 `store.go` 顶部注释，如实描述当前迁移行为（8 个幂等补列函数，无版本号）。
   注意：**这只是把注释改对**，要不要改迁移机制本身是 `MIG-1` 的事
3. `docs/TECHNOLOGY_EVOLUTION.md` 里过期的断言改成现状，或标 TODO 并指向对应任务 ID

**怎么算做完**

- 不存在自相矛盾的陈述
- `CONTEXT.md`（领域语言）和 `docs/design/`（实现设计）的职责边界在 `AGENTS.md` 里写清

**触及**：`docs/design/task-unification.md`、`docs/TECHNOLOGY_EVOLUTION.md`、
`internal/store/store.go`、`CONTEXT.md`、`AGENTS.md`

**并行冲突**：与 `STORE-1`、`STORE-2`、`MIG-1`、`MODEL-1` 同改 `store.go`

---

### 二、门禁与构建（3 项）

减少「每次改动要记住的规矩」。

---

#### GATE-1 · 把内嵌前端产物移出 git

**工作量**：1 天

**现状**

见 1.2。产物入库导致 diff 噪声 + 门禁重复构建。

**做什么**

1. `internal/web/dist/` 加进 `.gitignore`。
   注意 `go:embed dist` 要求目录存在，所以留一个 `internal/web/dist/.gitkeep`，
   或者改成 `//go:embed all:dist`，并在 dist 为空时让 `pageApp` 给出清晰错误
   （「前端未构建，请运行 make frontend」）而不是 500
2. `Makefile` 里 `build` 和 `release` 加前置依赖 `frontend`
3. CI 在 `go build` 之前跑 `npm ci && npm run build:frontend`
4. 删掉 `scripts/build-frontend.sh` 的 `--check` 分支和 `normalize_output`（那个 `sed`
   抹行尾空白的 hack 只是为了让 diff 比得平，产物不入库后就没意义了）
5. `Makefile` 的 `frontend-check` 目标相应简化为只跑 typecheck + lint

**怎么算做完**

- 改前端后 `git status` 只显示源码文件
- `make check` 里 Vite 只跑一次
- `make build` 出来的单二进制仍能正常 serve `/` 和 `/static/`（手动验一次）
- 全新 clone + `npm ci && make build` 能出可用二进制

**触及**：`.gitignore`、`Makefile`、`scripts/build-frontend.sh`、
`.github/workflows/ci.yml`、`internal/web/`

---

#### GATE-2 · 分层门禁：check-go / check-web / check

**工作量**：0.5 天

**现状**

`make check` = `fmt-check` + `mod-tidy-check` + `frontend-check` + `frontend-test` +
`vet` + `test` + `build`，七步串行。改一个 Go handler 也要跑 typecheck、eslint（5.6s）、
Vitest 和两次 Vite。

**做什么**

```makefile
check-go:  fmt-check mod-tidy-check vet test build
check-web: typecheck lint frontend-test
check:     check-go check-web
```

CI 继续跑全量 `check`（不放松），本地按改动面挑。`CONTRIBUTING.md` 写清什么时候用哪个。

**怎么算做完**

- `make help` 列出三个目标
- 纯 Go 改动执行 `make check-go` 即可自证
- CI 行为不变

**触及**：`Makefile`、`CONTRIBUTING.md`

---

#### GATE-3 · 把 exec 包的真实 sleep 换成可注入时钟

**工作量**：1–2 天

**现状**

见 2.5。两个用例各真睡 4.01 秒，等的是 `waitTmux` 里写死的时间窗口。
`tmux_test.go` 另有一批依赖 `tmux`/`systemd-run`/`setsid` 的集成用例，
在缺这些工具的环境下会 skip，但在 CI 上会真跑。

**做什么**

1. 把 `waitTmux` 的心跳间隔、退出确认窗口提成 `Executor` 的字段，
   生产默认值保持现在的数值不变
2. 两个慢用例注入毫秒级的值
3. tmux 集成用例加 `if testing.Short() { t.Skip(...) }`

**注意**：不要为了快而改判定逻辑本身——这两个用例测的是
「agent 已确认结束但退出码延迟到达」和「未知的 detached agent 仍在输出时要继续观察」，
都是真实踩过的坑，行为必须原样保留。

**怎么算做完**

- `go test -short ./...` 在 5 秒内跑完
- 不带 `-short` 的完整测试断言未改，仍然通过
- `internal/exec` 的耗时从 16.0s 降到 3s 以内

**触及**：`internal/exec/executor.go`、`internal/exec/executor_tmux_test.go`、
`internal/exec/tmux_test.go`

---

### 三、结构拆分（6 项）

**这一组全部是纯移动或等价重构，不改任何行为。**
测试应当一行不改就通过——这既是约束也是验收标准。

---

#### TEST-1 · 抽出 server 包的测试脚手架

**工作量**：0.5 天

**现状**

见 1.3 和 2.4。12 个测试文件各自复制同一段六行 bootstrap，
`server.New` 有 8 个参数，加一个依赖要改 13 处。

**做什么**

新建 `internal/server/testenv_test.go`：

```go
type testEnv struct {
    server   *Server
    store    *store.Store
    hub      *events.EventStream
    executor *exec.Executor
    root     string
}

func newTestServer(t *testing.T, opts ...testOpt) *testEnv
```

用 option 覆盖各文件的差异点（有的传 `nil` executor，有的传真 executor；
有的用 `:memory:`，`session_api_test.go` 用真实文件库；skillsDir 各不相同）。
12 个文件改为调用它。

**怎么算做完**

- `grep -c "sched.New(st" internal/server/*_test.go` 结果为 1
- `go test ./internal/server` 通过，且没有改动任何断言

**触及**：`internal/server/testenv_test.go`（新）、`internal/server/*_test.go` ×12

---

#### HTTP-1 · 按资源拆 handlers.go，并把路由注册收口

**工作量**：1–2 天

**现状**

`handlers.go` 2256 行 70 个函数，混装 task、role、template、project、runtime、skill、
文件系统浏览、统计、扩展安装九类职责，中间还夹着 `copyDir`、`parseSkillFrontmatter`、
`skillSlug` 这类通用工具函数。

路由注册也是分裂的：46 条集中在 `server.go` 的 `routes()` 里，
另外 12 条散在 `artifact_handlers.go`、`workflow_handlers.go`、`session_handlers.go`
各自的 register 函数里。想知道「一共有哪些 API」，要翻四个文件。

**做什么**

按资源切分，每个文件自带 register 函数：

```
task_handlers.go      registerTaskRoutes(mux)
role_handlers.go      registerRoleRoutes(mux)
project_handlers.go   registerProjectRoutes(mux)
skill_handlers.go     registerSkillRoutes(mux)
runtime_handlers.go   registerRuntimeRoutes(mux)
fs_handlers.go        registerFSRoutes(mux)
stats_handlers.go     registerStatsRoutes(mux)
```

`server.go` 只保留一串 register 调用。通用工具函数收进 `internal/server/util.go`。
**纯移动，不改函数体。**

**怎么算做完**

- 没有单文件超过 400 行
- 全部 58 条路由能从一串 register 函数里一次枚举出来
- `go test ./internal/server` 不改断言即通过

**触及**：`internal/server/handlers.go`、`internal/server/server.go`，及新增的分文件

**并行冲突**：与 `HTTP-2` 同改 `handlers.go`

---

#### HTTP-2 · 拆开 280 行的 patchTask

**工作量**：1 天

**现状**

`handlers.go:265` 起的单个函数里叠了六件事：

1. revision 校验（`If-Match`）
2. 15 个字段的白名单解析
3. `dependency_mode` / `depends_on` 的合法性校验
4. `cron` / `enabled` 的类型检查 + 调度器重载
5. 合并任务（`merge_of != nil`）的字段保护——只允许改 status 和 role_id
6. 审批与驳回分支（转 `approveReviewTask`）

任何一条任务编辑规则的改动，都要在这团里先定位。

**做什么**

引入 `taskPatch` 结构体，按四段拆：

```
parseTaskPatch(r)     → taskPatch, error     // 解析 + 类型检查
(taskPatch).validate() → error                // 字段级合法性
authorizeTaskPatch(cur, patch) → error        // 合并任务保护、状态机准入
applyTaskPatch(...)                            // 落库 + 副作用（调度器重载、审批分支）
```

审批路径继续走已有的 `approveReviewTask`，不要重写。

**怎么算做完**

- 主函数 < 60 行
- `dependency_test.go`、`merge_flow_test.go`、`project_assignment_test.go` 原样通过

**触及**：`internal/server/handlers.go`

**并行冲突**：与 `HTTP-1` 同改 `handlers.go`

---

#### STORE-1 · 按聚合拆 store.go

**工作量**：1–2 天

**现状**

3536 行一个文件，装着：DDL、8 个迁移函数、revision 乐观锁机制、
tasks 的依赖图校验与删除树、roles、projects、templates、skills、settings、
统计聚合、日志分页。

**做什么**

```
schema.go       schema 常量 + verifyCurrentSchema + seedDefaultTemplate
migrations.go   8 个 migrateXxx
revision.go     UpdateAtRevision / AssertRevision / updateOne 系列
tasks.go        Task 的 CRUD + 依赖图 + 删除树 + 合并任务
roles.go        Role
projects.go     Project + ReorderProjectTasks
catalog.go      Template + Skill + Setting
stats.go        RoleStatsOf / ProjectStatsOf / OverviewStatsOf
logs.go         TaskLog + EventRecord
```

`store_test.go`（1374 行）同步拆分。**SQL 一行不改。**

**怎么算做完**

- 单文件均 < 700 行
- `go test ./internal/store` 通过

**触及**：`internal/store/store.go`、`internal/store/store_test.go`

**并行冲突**：与 `STORE-2`、`MIG-1`、`MODEL-1`、`DOC-1` 同改 `store.go`

---

#### STORE-2 · 让 tasks 的列清单与扫描由同一份定义派生

**工作量**：1 天

**现状**

见 1.1 的第 4、5、6 项。`taskCols` 和 `taskColsBrief` 是两份手写的 52 列 SELECT 字符串，
唯一区别是 `taskColsBrief` 把 body 截断成 `substr(t.body,1,400)`。
两者必须与 `scanTask` 的 52 个 Scan 参数逐位对齐，而错位不会编译报错。

**做什么**

定义一张表，让三者都从它派生：

```go
type taskColumn struct {
    expr      string                    // "t.title"
    briefExpr string                    // 空表示与 expr 相同
    scan      func(*taskScanTarget) any // 指向 scan 中转结构的字段
}

var taskColumns = []taskColumn{...}
```

`taskCols`、`taskColsBrief` 由 `taskColumns` 拼接生成（`init` 或 `sync.Once`）；
`scanTask` 遍历它构造 `rows.Scan` 的参数切片。

再加一个单测：把 `taskColumns` 的列名集合与 `PRAGMA table_info(tasks)` 比对，
不一致直接失败。

**注意**：`scanTask` 里有一堆 `sql.NullInt64` → `*int64` 的转换和默认值兜底
（`type` 为空补 `task`、`run_mode` 为空补 `batch`），这部分逻辑要原样保留在派生之后。

**怎么算做完**

- 新增一列只需改一处
- 故意在测试里漏改一列时，测试直接失败而不是运行时报错
- `go test ./internal/store` 通过

**触及**：`internal/store/store.go`

**并行冲突**：与 `STORE-1`、`MIG-1`、`MODEL-1`、`DOC-1` 同改 `store.go`

---

#### RT-1 · 按运行时收拢六个 CLI 适配器

**工作量**：1 天

**现状**

六个运行时（pi / omp / opencode / codex / claude / dsh）的实现被劈成两半：

- `command_runtimes.go`（925 行）：`Build`、`Schema`、`Warnings`、`Detect`、`Docs`
- `models.go`（1200 行）：`Models`、`ModelCatalog` 以及各家的探测逻辑
  （`piListModelsRows`、`parseOmpModelsJSON`、`opencodeModelCatalogProbe`、
  `codexModelsProbe`、`claudeModelsProbeAt`、`dshModelCandidates`……）

改一个运行时要在两个大文件之间来回跳，而且两处的适配器排列顺序还不一致
（`command_runtimes.go` 是 omp/opencode/pi/claude/codex/dsh，
`models.go` 是 pi/omp/opencode/codex/claude/dsh）。

**做什么**

```
runtime_pi.go        piAdapter 的全部方法 + 模型探测
runtime_omp.go       同上
runtime_opencode.go  同上
runtime_codex.go     同上
runtime_claude.go    同上（claude 的 settings/state 文件读取也归这里）
runtime_dsh.go       同上
model_cache.go       公共的 TTL 缓存、磁盘落盘、RefreshModelCatalogs
adapter.go           commandAdapter 接口 + registry + baseAdapter + mergeEnv
```

**怎么算做完**

- 「新增一个运行时」= 新增一个文件 + 一行 `register(...)`
- `adapters_test.go`、`models_test.go` 通过

**触及**：`internal/exec/command_runtimes.go`、`internal/exec/models.go`

---

#### FE-1 · 拆 tasks.tsx 与 resources.tsx

**工作量**：2 天

**现状**

```
tasks.tsx      931 行  30 个 useState  46 处 query/mutation
resources.tsx  675 行  26 个 useState  41 处
management.tsx 437 行  34 个 useState  31 处
```

列表、详情抽屉、新建对话框、依赖编辑器全挤在一个组件文件里。
改一个按钮的行为要先把整页读一遍才敢下手。

**做什么**

按「页面负责数据编排，子组件只负责展示」拆：

```
pages/tasks.tsx           只保留路由级的数据获取与状态编排
components/task/List.tsx
components/task/Detail.tsx
components/task/CreateDialog.tsx
components/task/DependencyEditor.tsx
hooks/useTasks.ts         全部 mutation
```

`components/ui.tsx` 里已有 `Dialog` / `Field` / `Badge` / `Card` / `Empty` / `Spinner`，
优先复用，不要再造一套。

**怎么算做完**

- 单文件 < 300 行
- `npm test` 与 `scripts/e2e.sh` 通过
- 界面无可见变化（拆之前先截图对照）

**触及**：`frontend/src/pages/tasks.tsx`、`frontend/src/pages/resources.tsx`、
`frontend/src/components/`

---

### 四、契约与边界（4 项）

消除「四张手写清单互不校验」——这一组直接对着 1.1 的病根。

---

#### API-1 · 让 OpenAPI 反映真实路由，或者删掉它

**工作量**：1–2 天

**现状**

见 2.2。58 条路由 vs 34 条 path，守卫测试形同虚设。

现在这个状态是最坏的：契约存在、有端点（`GET /api/v1/openapi.yaml`）对外提供、
架构文档还把它列为卖点，但它只描述了 59% 的 API。
按它写客户端的人会踩坑，而且不知道自己踩了。

**做什么**

**方案 A（推荐）**——让契约变成真的：

1. 重构路由注册，让所有 `method + path` 能被程序枚举
   （最简单的做法：注册时同时往一个 `[]route` 切片里追加；
   如果先做了 `HTTP-1`，register 函数已经是收口的，这一步更简单）
2. 写测试：提取路由集合，与 `openapi.yaml` 的 paths 做**双向**比对，任一侧多出即失败
3. 一次性补齐缺的 24 条

**方案 B**——确认没有外部消费者后，删掉 `openapi.yaml`、`openapi.go`、
`/api/v1/openapi.yaml` 端点，并把 `docs/TECHNOLOGY_EVOLUTION.md` 里的说法改掉。
半真的契约比没有契约更贵。

**怎么算做完**

- 方案 A：新增一条路由但忘了写契约时，`go test ./internal/server` 失败
- 方案 B：契约与端点一并消失，文档同步更新

**触及**：`internal/server/openapi.yaml`、`internal/server/openapi.go`、
`internal/server/openapi_test.go`、`internal/server/server.go`

---

#### API-2 · 消除重复路由与命名不一致

**工作量**：0.5 天

**现状**

见 2.9。`PUT` 和 `PATCH /projects/{id}/tasks/order` 指向同一 handler；
`/stats/roles/{id}` 用复数而 `/stats/project/{id}` 用单数。

**做什么**

定一条规则并写进 `AGENTS.md` 或架构文档：

- 资源段一律复数（`/stats/projects/{id}`）
- 整序替换用 `PUT`，局部修改用 `PATCH`

按规则删掉多余的那条，前端 `pages/tasks.tsx` 里的调用同步改。
`/stats/project/{id}` 改名属于破坏性变更，但这是自托管单实例、前后端同版本发布，
风险可控——改完确认前端页面正常即可。

**怎么算做完**

- 没有两条路由指向同一个 handler
- 资源命名在路由表里前后一致

**触及**：`internal/server/server.go`、`frontend/src/pages/tasks.tsx`、
`internal/server/openapi.yaml`

---

#### ARCH-1 · 给 application 层一个结论：补齐，或者合并回去

**工作量**：2–3 天

**现状**

见 2.3。`internal/application` 有三个 service（`TaskLifecycle`、`WorkflowService`、
`WorkspaceService`），但 server 包里 107 处直接调 store，只有 17 处走 service。

具体说，`TaskLifecycle` 只有 `Create` 和 `CanTransition` 两个方法。
任务的审批、驳回、取消、恢复、级联删除全在 `handlers.go` 里，
直接操作 `s.st`。所以：

- 想知道「审批一个任务会发生什么」，要读 `handlers.go` 的 `approveReviewTask`
- 想知道「创建一个任务会发生什么」，要读 `application/task_lifecycle.go`
- 两者共享的规则（权限收敛、依赖校验）在两边各写一遍

这一层现在的效果是**增加了阅读成本却没有降低耦合**。

**做什么**

必须选一条，不能维持现状：

**方案 A · 补齐** — 把状态流转上移进 `TaskLifecycle`：

```go
func (s *TaskLifecycle) Approve(id int64, note string) (*store.Task, error)
func (s *TaskLifecycle) Reject(id int64, note string) (*store.Task, error)
func (s *TaskLifecycle) Cancel(id int64) error
func (s *TaskLifecycle) Resume(id int64) (*store.Task, error)
func (s *TaskLifecycle) Delete(id int64) error
```

handler 只做 HTTP 解析、revision 校验、鉴权。完成后 handler 里的 `s.st` 只剩纯读。

**方案 B · 合并** — 承认它是薄封装，把三个 service 的方法挂回 `*Server`，
删掉 `internal/application` 包。少一层，`server` 包内部再按资源分文件（和 `HTTP-1` 呼应）。

我倾向 **A**：编排者会话（`internal/orchestrator`）已经在复用 `TaskLifecycle.Create`，
`sched` 也依赖 `WorkflowService`，说明这一层确实有跨调用方的价值，只是没补完。
但 B 也是合理选择——关键是**选一个并写进 `docs/TECHNOLOGY_EVOLUTION.md`**。

**怎么算做完**

- 「改一条任务状态规则」只需要读一个包
- 架构文档里的分层图与代码一致
- `internal/server` 的测试不需要为了这次重构改断言（行为等价）

**触及**：`internal/application/`、`internal/server/handlers.go`、
`docs/TECHNOLOGY_EVOLUTION.md`

---

#### TYPE-1 · 前后端类型一致性做成门禁

**工作量**：1–2 天

**现状**

`frontend/src/types.ts` 346 行，是手抄的 `internal/store/models.go`。
`Task` 接口约 50 个字段，其中大量是 optional（`?`）——因为单表承载三种形态，
很多字段对特定形态不存在。这让「漏抄」变得完全无声：
少写一个字段，TypeScript 不报错，运行时是 `undefined`。

**做什么**

**首选**：写一个生成器。

```
scripts/gen-types.go   读 internal/store/models.go 的 struct + json tag，输出 types.ts
make gen-types         本地生成
CI: make gen-types && git diff --exit-code   # 漏同步就红
```

Go 的 `go/ast` 解析 struct tag 不难，几十行就够。
需要处理的映射：`*int64` → `ID | null`、`[]string` → `string[]`、
`map[string]string` → `Record<string, string>`、有 `omitempty` 的加 `?`。

**次选**（如果嫌生成器重）：加一个契约测试。
Go 侧用反射列出 `Task`/`Role`/`Project` 的 json 字段名集合，
写进一个 golden 文件；前端加一个 Vitest 从 `types.ts` 解析字段名做比对。
不如生成器彻底，但至少漏同步会在 CI 失败。

**怎么算做完**

- 给 `Task` 加字段但没同步前端时，CI 失败并明确指出缺哪个字段
- 不再需要人肉记住「加字段要改 types.ts」

**触及**：`frontend/src/types.ts`、`internal/store/models.go`、`scripts/`、
`Makefile`、`.github/workflows/ci.yml`

---

### 五、数据模型（2 项，需要单独排期）

影响面最大、风险最高。建议各自独立成一个里程碑，**不要顺手夹在功能改动里做**。

---

#### MODEL-1 · 给 tasks 单表补上形态边界

**工作量**：3–5 天

**现状**

一张 `tasks` 表 52 列，承载 `task` / `session` / `workflow` 三种形态，外加 cron 正交属性。

对特定形态永远为空的列：

| 只对 `session` 有意义 | 只对 `workflow` 有意义 |
|---|---|
| `worktree_path` | `spec` |
| `session_dir` | `violations` |
| `last_message_at` | `spec_hash` |
| `message_count` | |
| `suspended_at` | |
| `delivered_at` | |

数据库层面没有任何约束阻止写错组合——可以插入一条 `type='task'` 却带 `spec` 的记录。
Go 层面也没有形态视图，任何一段代码在读这些字段前都得自己先判断 `type`，
而这个判断散落在 store、server、session、orchestrator 四个包里。

**做什么**

**明确不拆表。** 单表是 `CONTEXT.md` 定下的领域模型（Task 是唯一实体），
拆表会推翻整个领域语言，代价远大于收益。改在两个地方：

1. **Go 侧加形态视图**，把 `type` 判断收敛到一处：

```go
type SessionTask struct {
    Task
    WorktreePath string
    SessionDir   string
    // ... 只暴露对 session 有意义的字段
}

func (t Task) AsSession() (SessionTask, bool)
func (t Task) AsWorkflow() (WorkflowTask, bool)
```

业务代码拿到 `SessionTask` 之后不需要再判断 `type`，也访问不到跨形态字段。

2. **schema 加 CHECK 约束**，让非法组合在数据库层被拒：

```sql
CHECK (type = 'workflow' OR (spec = '' AND spec_hash = ''))
CHECK (type = 'session'  OR (session_dir = '' AND message_count = 0))
```

（具体约束要按现有数据核对——先跑一遍查询确认存量数据不违反。）

**怎么算做完**

- 全仓不存在散落的「先判断 type 再读字段」分支
- 插入非法组合被 SQLite 拒绝，且有测试覆盖
- 现有测试全绿

**触及**：`internal/store/models.go`、`internal/store/store.go`（schema）、
`internal/session/`、`internal/application/workflow_service.go`、`internal/server/`

**并行冲突**：改 schema，与 `MIG-1`、`STORE-1`、`STORE-2`、`DOC-1` 都会撞 `store.go`

---

#### MIG-1 · 迁移策略一致化

**工作量**：2 天

**现状**

`Open()` 里按顺序执行 8 个幂等补列函数：

```
migrateWorkflowRunsProjectColumn
migrateWorkflowRunsTaskColumn
migrateSkillsCategoryColumn
migrateProjectGitHubColumns
migrateTaskExternalKeyColumn
migrateTaskParentColumns
migrateRoleDelegationColumns
migrateTaskMergeSkippedColumn
```

它们的做法都是「查 `PRAGMA table_info`，缺列就 `ALTER TABLE ADD COLUMN`」，
所以重复执行安全。但**没有版本号**：`PRAGMA user_version` 在 schema 里写死 `1`，
从来不推进。于是无法回答「这个库是哪一代的」「能不能跑新版本」，
只能靠启动试一次。

`verifyCurrentSchema` 会检查关键列是否存在，但那是事后检查，不是版本管理。

**做什么**

选一条：

**方案 A · 正规化** — 编号迁移：

```go
var migrations = []struct{
    version int
    apply   func(*sql.DB) error
}{
    {2, migrateWorkflowRunsProjectColumn},
    // ...
    {9, migrateTaskMergeSkippedColumn},
}
```

启动时读 `user_version`，从当前版本往后逐个执行并推进版本号。
低于最低支持版本时明确拒绝启动。

**方案 B · 简化** — 正式宣布「只支持全新库」：
删掉 8 个函数和 `migration_delegation_test.go`，
`verifyCurrentSchema` 遇到旧库直接拒绝启动，并在错误里给出重建指引
（导出数据 → 删库 → 重启 → 导入）。

如果这是个人自托管的单实例、可以承受重建，B 更省事且诚实。
如果已经有真实数据不能丢，走 A。

**怎么算做完**

- schema 版本能从数据库直接查出（`PRAGMA user_version`）
- 代码注释、`docs/DEPLOYMENT.md` 与实际行为三者一致
- 有测试覆盖「旧库 → 新版本」的路径（方案 A）或「旧库被明确拒绝」（方案 B）

**触及**：`internal/store/store.go`、`internal/store/migration_delegation_test.go`、
`docs/DEPLOYMENT.md`

**并行冲突**：与 `STORE-1`、`STORE-2`、`MODEL-1`、`DOC-1` 同改 `store.go`

---

## 4. 并行、冲突与优先级

### 4.1 独立性

19 项在**范围**上互不依赖：任何一项单独做完都能合入并产生价值，
不需要等其他任务先完成。

### 4.2 会撞车的组合

**范围独立 ≠ 文件独立。** 下面两组会改同一个文件，别同时开分支：

| 文件 | 涉及任务 |
|---|---|
| `internal/server/handlers.go` | `HTTP-1`、`HTTP-2` |
| `internal/store/store.go` | `STORE-1`、`STORE-2`、`MIG-1`、`MODEL-1`、`DOC-1` |

`store.go` 这组建议的内部顺序（如果要连着做）：
`DOC-1`（改注释，最小）→ `STORE-1`（拆文件）→ `STORE-2` / `MIG-1` / `MODEL-1`（此时已在各自小文件里，互不冲突）。
但这只是省事，不是依赖——单独做任何一项都成立。

同理，`HTTP-1` 先做完，`HTTP-2` 就是在小文件里改，更舒服。
`HTTP-1` 也会让 `API-1` 的方案 A 更容易实现（路由注册已收口）。

### 4.3 如果只做三项

| 任务 | 为什么是它 |
|---|---|
| **GATE-1** 产物出库 | 每次前端提交少 14 个噪声文件，`make check` 少一次 Vite 构建，少一条要记住的规矩 |
| **TEST-1** 测试脚手架 | 把「加一个依赖改 13 处」变成「改 1 处」，成本 0.5 天，收益立刻兑现 |
| **API-1** 契约比对 | 最容易腐坏、当前腐坏最严重的一张手写清单，第一次有人看守 |

### 4.4 收益最大但成本也最高的两项

- **TYPE-1**：直接解决 1.1 的病根（四张清单没人比对）。做完之后，加字段的成本从
  「记住 10 个地方」降到「改 6 个地方 + CI 兜底剩下的」。
- **ARCH-1**：决定 `application` 层的去留。不做的话，这层会一直是阅读成本，
  而且新功能会继续在两边分裂地实现。

### 4.5 建议不做的事

- **不要拆 `tasks` 表**。单表是领域模型的核心决策，拆表要推翻 `CONTEXT.md`
  和四个页面的设计。`MODEL-1` 的方案（Go 形态视图 + DB CHECK）能拿到 80% 的收益，
  代价小一个数量级。
- **不要引入新框架**。当前的 `net/http` + 手写 mux + `database/sql` 直连
  没有任何问题，上面所有痛点都是「同一事实写多份」和「文件太大」造成的，
  换 ORM 或 Web 框架只会增加一层新的映射需要维护。

---

## 附录：一次性复现全部体检数据

```bash
# 规模
find . -name '*.go' -not -path './node_modules/*' | xargs wc -l | sort -rn | head -10

# 路由 vs 契约
grep -ohE '"(GET|POST|PATCH|PUT|DELETE) /api/v1[^"]*"' internal/server/*.go | sort -u | wc -l
grep -cE '^  /' internal/server/openapi.yaml

# 分层采纳率
grep -o "s\.st\.[A-Za-z]*" internal/server/*.go | grep -v _test | wc -l
grep -o "s\.\(tasks\|workflows\|workspaces\)\.[A-Za-z]*" internal/server/*.go | grep -v _test | wc -l

# 测试样板
grep -l "sched.New(st" internal/server/*_test.go | wc -l

# 门禁耗时
time go test ./cmd/... ./internal/...
time npm run typecheck && time npm run lint && time npm test
time ./scripts/build-frontend.sh --check

# 死代码（无网络时的启发式；有网络可用 golang.org/x/tools/cmd/deadcode）
grep -rn "visualization" internal --include=*.go | grep -v "^internal/visualization"

# 不该入库的文件
git ls-files | grep -E 'c\.txt|sse\.log|all_cmds|tmp\.cjs'
```
