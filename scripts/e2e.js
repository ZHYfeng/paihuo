// 端到端回归（由 scripts/e2e.sh 调用）：
// 1) 登录 → 遍历全部页面，收集 pageerror/console.error 与横向溢出
// 2) 关键交互：角色弹窗、任务弹窗、项目弹窗 + 目录选择器、安装面板、技能双 tab
// 退出码：0 = 全部通过；1 = 有错误
const path = require("path");
const os = require("os");
const fs = require("fs");

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (_) {
  try {
    ({ chromium } = require("playwright-core"));
  } catch (_) {
    throw new Error("未找到 Playwright。请执行 npm ci && npx playwright install chromium，或安装 playwright-core。\n");
  }
}

const URL = process.env.E2E_URL || "http://127.0.0.1:8099";
const TOKEN = process.env.E2E_TOKEN || "t";
const [W, H] = (process.env.E2E_VIEWPORT || "1440x900").split("x").map(Number);
const PAGES = ["/", "/board", "/roles", "/agents", "/projects", "/skills", "/history", "/settings", "/autopilots", "/templates"];

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const bundled = chromium.executablePath();
  if (bundled && fs.existsSync(bundled)) return bundled;
  const base = path.join(os.homedir(), ".cache", "ms-playwright");
  const candidates = [];
  try {
    for (const d of require("fs").readdirSync(base)) {
      for (const sub of ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-headless-shell-linux64/chrome-headless-shell"]) {
        const p = path.join(base, d, sub);
        try { if (require("fs").statSync(p).isFile()) candidates.push(p); } catch (_) {}
      }
    }
  } catch (_) {}
  if (!candidates.length) throw new Error("未找到 chromium，请设置 CHROME_PATH 或安装 playwright-core 的浏览器");
  return candidates.sort().pop(); // 取最新版本
}

(async () => {
  const browser = await chromium.launch({ executablePath: findChrome() });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errors = [];
  page.on("pageerror", e => errors.push(`[${page.url()}] PAGEERROR: ${e.message}`));
  page.on("console", m => { if (m.type() === "error") errors.push(`[${page.url()}] CONSOLE: ${m.text()}`); });

  let failed = false;
  const fail = msg => { failed = true; console.log("  ✗ " + msg); };
  const ok = msg => console.log("  ✓ " + msg);

  // 登录
  await page.goto(URL + "/login");
  const loginReady = await page.evaluate(() => {
    const card = document.querySelector(".login-card");
    const input = document.getElementById("loginToken");
    if (!card || !input) return false;
    const style = getComputedStyle(card);
    const rect = input.getBoundingClientRect();
    return style.visibility !== "hidden" && Number(style.opacity) > 0.99 && rect.width > 0 && rect.height > 0;
  });
  loginReady ? ok("登录表单首屏可见") : fail("登录表单首屏不可见");
  await page.fill("input[type=password]", TOKEN);
  await page.click("button[type=submit]");
  await page.waitForTimeout(900);
  if (!page.url().includes("/login")) ok("登录"); else fail("登录失败");

  // 1) 全部页面：JS 错误 + 横向溢出
  console.log("— 页面回归 —");
  for (const p of PAGES) {
    await page.goto(URL + p);
    await page.waitForTimeout(900);
    const overflow = await page.evaluate(() => {
      const bad = [];
      document.querySelectorAll("button, a.btn, .card, .toolbar, .seg, .dash-col, .dash-side").forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.right > window.innerWidth + 2) bad.push((el.className || el.tagName).toString().slice(0, 40));
      });
      return bad;
    });
    if (overflow.length) fail(`${p} 横向溢出: ${overflow.slice(0, 3).join(", ")}`);
    else ok(p);
  }

  // OMP 回答会密集使用 GFM 表格、多级列表和代码块。直接挂载一条
  // assistant 消息，同时校验语义 DOM、横向表格样式和不可信 HTML/链接清洗。
  await page.goto(URL + "/sessions");
  const markdownProbe = await page.evaluate(async () => {
    window.__paihuoMarkdownXss = 0;
    const el = document.createElement("ph-msg-assistant");
    el.msg = {
      role: "assistant",
      content: [{
        type: "text",
        text: [
          "# OMP 标题",
          "",
          "第一段有 **粗体** 和 `inline()`。",
          "",
          "第二段不应和第一段挤在一起。",
          "",
          "- 无序一",
          "- 无序二",
          "  - 嵌套项",
          "",
          "1. 有序一",
          "2. 有序二",
          "",
          "| 工具 | 能力 |",
          "|---|---|",
          "| read | 读取 |",
          "| bash | 执行 |",
          "",
          "[safe](https://example.com) [relative](docs/guide.md) [unsafe](javascript:evil)",
          "",
          "```js",
          "const answer = 42;",
          "```",
          "",
          '<img src=x onerror="window.__paihuoMarkdownXss=1"><script>window.__paihuoMarkdownXss=2</script>',
        ].join("\n"),
      }],
    };
    document.body.appendChild(el);
    await el.updateComplete;
    const root = el.shadowRoot;
    const part = root.querySelector(".part.ph-md");
    const links = [...root.querySelectorAll("a")];
    const link = text => links.find(a => a.textContent === text);
    const table = root.querySelector("table");
    const result = {
      heading: root.querySelector("h1")?.textContent,
      paragraphs: root.querySelectorAll("p").length,
      unorderedItems: root.querySelectorAll("ul > li").length,
      nestedItems: root.querySelectorAll("ul ul > li").length,
      orderedItems: root.querySelectorAll("ol > li").length,
      tableRows: root.querySelectorAll("table tr").length,
      codeCopy: !!root.querySelector(".code-block-wrapper .code-copy-button"),
      codeLanguage: root.querySelector("pre code")?.dataset.lang,
      markdownClass: !!part,
      tableOverflow: table ? getComputedStyle(table).overflowX : "",
      safeHref: link("safe")?.getAttribute("href"),
      relativeHref: link("relative")?.getAttribute("href"),
      unsafeHref: link("unsafe")?.getAttribute("href"),
      safeRel: link("safe")?.getAttribute("rel"),
      unsafeTags: part?.querySelectorAll("script, img, button:not(.code-copy-button)").length ?? -1,
      xss: window.__paihuoMarkdownXss,
    };
    el.remove();
    return result;
  });
  const markdownOK = markdownProbe.heading === "OMP 标题" &&
    markdownProbe.paragraphs >= 2 && markdownProbe.unorderedItems === 3 &&
    markdownProbe.nestedItems === 1 && markdownProbe.orderedItems === 2 &&
    markdownProbe.tableRows === 3 && markdownProbe.codeCopy &&
    markdownProbe.codeLanguage === "js" && markdownProbe.markdownClass &&
    markdownProbe.tableOverflow === "auto" &&
    markdownProbe.safeHref === "https://example.com" &&
    markdownProbe.relativeHref === "docs/guide.md" &&
    markdownProbe.unsafeHref === "#" && markdownProbe.safeRel === "noopener noreferrer" &&
    markdownProbe.unsafeTags === 0 && markdownProbe.xss === 0;
  markdownOK ? ok("OMP 消息 GFM 渲染与 HTML 清洗") : fail(`OMP markdown 回归失败：${JSON.stringify(markdownProbe)}`);

  // 会话输入区的模板选择只修改草稿，不触发发送；已有草稿按当前选区
  // 保留，并在模板两侧补段落间隔。组件实例内覆写加载函数，避免依赖
  // 回归数据库里是否预置模板。
  const sessionTemplateProbe = await page.evaluate(async () => {
    const el = document.createElement("ph-session-input");
    el.session = { id: 999, status: "active" };
    el.running = false;
    el._loadTemplates = async function () {
      this.templates = [{ id: 7, name: "发布检查", body: "模板正文" }];
      this.templatesLoading = false;
      this.templatesFailed = false;
    };
    document.body.appendChild(el);
    await el.updateComplete;
    el.value = "前后";
    await el.updateComplete;
    const editor = el.shadowRoot.querySelector("textarea");
    editor.focus();
    editor.setSelectionRange(1, 1);
    const picker = el.shadowRoot.querySelector(".template-picker");
    picker.value = "7";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await el.updateComplete;
    await new Promise(requestAnimationFrame);
    const result = {
      value: editor.value,
      cursor: editor.selectionStart,
      pickerReset: picker.value,
      focused: el.shadowRoot.activeElement === editor,
      label: picker.getAttribute("aria-label"),
    };
    el.remove();
    return result;
  });
  const sessionTemplateOK = sessionTemplateProbe.value === "前\n\n模板正文\n\n后" &&
    sessionTemplateProbe.cursor === 7 && sessionTemplateProbe.pickerReset === "" &&
    sessionTemplateProbe.focused && sessionTemplateProbe.label === "插入模板";
  sessionTemplateOK ? ok("会话草稿插入模板") : fail(`会话模板插入回归失败：${JSON.stringify(sessionTemplateProbe)}`);

  // 顶部进度条表示全文中的实际阅读位置。仅加载尾部 100/1000 条时，
  // 可见窗口应覆盖 90%–100%；全部历史加载后则覆盖 0%–100%。
  const sessionProgressProbe = await page.evaluate(() => {
    const stream = document.createElement("ph-message-stream");
    const metrics = scrollTop => ({ scrollTop, scrollHeight: 1100, clientHeight: 100 });
    const tail = { transcriptLoaded: 100, transcriptTotal: 1000, transcriptExhausted: false };
    const full = { transcriptLoaded: 1000, transcriptTotal: 1000, transcriptExhausted: true };
    const filteredFull = { transcriptLoaded: 80, transcriptTotal: 100, transcriptExhausted: true };
    return {
      tailTop: stream._railPercent(metrics(0), tail),
      tailMiddle: stream._railPercent(metrics(500), tail),
      tailBottom: stream._railPercent(metrics(1000), tail),
      fullTop: stream._railPercent(metrics(0), full),
      fullMiddle: stream._railPercent(metrics(500), full),
      fullBottom: stream._railPercent(metrics(1000), full),
      filteredTop: stream._railPercent(metrics(0), filteredFull),
      noOverflow: stream._railPercent({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 }, full),
    };
  });
  const near = (actual, expected) => Math.abs(actual - expected) < 0.001;
  const sessionProgressOK = near(sessionProgressProbe.tailTop, 90) &&
    near(sessionProgressProbe.tailMiddle, 95) && near(sessionProgressProbe.tailBottom, 100) &&
    near(sessionProgressProbe.fullTop, 0) && near(sessionProgressProbe.fullMiddle, 50) &&
    near(sessionProgressProbe.fullBottom, 100) && near(sessionProgressProbe.filteredTop, 0) &&
    near(sessionProgressProbe.noOverflow, 100);
  sessionProgressOK ? ok("会话顶部进度条跟随实际阅读位置") : fail(`会话进度条回归失败：${JSON.stringify(sessionProgressProbe)}`);

  // 2) 关键交互
  console.log("— 交互回归 —");
  await page.goto(URL + "/roles");
  await page.waitForTimeout(700);
  await page.evaluate(() => setAgentView("table"));
  // 手机端的角色表格会转成分区卡片：身份信息占满首行，操作区独占底部，
  // 避免四个按钮把角色名称压缩成逐字竖排，同时保持 44px 触控目标。
  await page.setViewportSize({ width: 320, height: 812 });
  await page.waitForTimeout(100);
  const mobileRoleTable = await page.evaluate(() => {
    const row = document.querySelector(".agent-list-row");
    if (!row) return { skipped: true };
    const rect = row.getBoundingClientRect();
    const identity = row.querySelector(".agent-list-identity")?.getBoundingClientRect();
    const actions = row.querySelector(".agent-list-actions")?.getBoundingClientRect();
    const buttons = [...row.querySelectorAll(".agent-list-actions .btn")].map(button => {
      const buttonRect = button.getBoundingClientRect();
      return { width: buttonRect.width, height: buttonRect.height };
    });
    const deleteLabel = row.querySelector(".agent-list-mobile-action-label");
    return {
      skipped: false,
      noOverflow: rect.left >= 0 && rect.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth,
      identityRatio: identity ? identity.width / rect.width : 0,
      actionsRatio: actions ? actions.width / rect.width : 0,
      buttons,
      deleteLabelVisible: !!deleteLabel && getComputedStyle(deleteLabel).display !== "none",
    };
  });
  if (mobileRoleTable.skipped) ok("角色表格移动端布局（无角色，跳过）");
  else {
    const mobileRoleTableOK = mobileRoleTable.noOverflow &&
      mobileRoleTable.identityRatio >= .55 && mobileRoleTable.actionsRatio >= .85 &&
      mobileRoleTable.buttons.length === 4 &&
      mobileRoleTable.buttons.every(button => button.width >= 44 && button.height >= 44) &&
      mobileRoleTable.deleteLabelVisible;
    mobileRoleTableOK ? ok("角色表格移动端布局") : fail(`角色表格移动端布局异常：${JSON.stringify(mobileRoleTable)}`);
  }
  await page.setViewportSize({ width: W, height: H });
  // 手机端的模板表格转成分区卡片：名称独占首行，角色/创建时间作为带
  // 标签的元信息并排，内容预览整行展示，操作按钮平铺成 44px 触控目标，
  // 避免 760px 表格在窄屏上横向滚动。
  await page.goto(URL + "/templates");
  await page.waitForTimeout(700);
  await page.setViewportSize({ width: 320, height: 812 });
  await page.waitForTimeout(100);
  const mobileTemplateTable = await page.evaluate(() => {
    const row = document.querySelector(".template-grid tbody tr");
    if (!row) return { skipped: true };
    const rect = row.getBoundingClientRect();
    const name = row.querySelector(".t-name")?.getBoundingClientRect();
    const body = row.querySelector(".t-body")?.getBoundingClientRect();
    const agent = row.querySelector(".t-agent")?.getBoundingClientRect();
    const created = row.querySelector(".t-created")?.getBoundingClientRect();
    const buttons = [...row.querySelectorAll(".t-ops .btn")].map(button => {
      const buttonRect = button.getBoundingClientRect();
      return { width: buttonRect.width, height: buttonRect.height };
    });
    const thead = document.querySelector(".template-grid thead");
    return {
      skipped: false,
      noOverflow: rect.left >= 0 && rect.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth,
      nameRatio: name ? name.width / rect.width : 0,
      bodyRatio: body ? body.width / rect.width : 0,
      agentOnLeft: agent ? agent.left < (created?.left ?? -1) : false,
      buttons,
      theadHidden: thead ? getComputedStyle(thead).position === "absolute" : false,
    };
  });
  if (mobileTemplateTable.skipped) ok("模板表格移动端布局（无模板，跳过）");
  else {
    const mobileTemplateTableOK = mobileTemplateTable.noOverflow &&
      mobileTemplateTable.nameRatio >= .85 && mobileTemplateTable.bodyRatio >= .85 &&
      mobileTemplateTable.agentOnLeft && mobileTemplateTable.theadHidden &&
      mobileTemplateTable.buttons.length === 3 &&
      mobileTemplateTable.buttons.every(button => button.width >= 44 && button.height >= 44);
    mobileTemplateTableOK ? ok("模板表格移动端布局") : fail(`模板表格移动端布局异常：${JSON.stringify(mobileTemplateTable)}`);
  }
  await page.setViewportSize({ width: W, height: H });
  // 后续角色交互依赖 /roles 页面，回到该页再继续。
  await page.goto(URL + "/roles");
  await page.waitForTimeout(700);
  // 角色创建/编辑统一走工作台：基本信息、完整配置和测试三栏必须同时存在；
  // 这里只验证工作台渲染和关闭，不触发真实 CLI，避免回归依赖外部模型额度。
  await page.evaluate(() => openRoleStudio());
  await page.waitForTimeout(350);
  const roleStudio = await page.evaluate(() => {
    const modal = document.getElementById("roleStudioModal");
    return !!modal && !modal.classList.contains("hidden") &&
      !document.getElementById("agentModal") &&
      !!document.getElementById("rsCreatorChat") &&
      !!document.getElementById("rsSchema") &&
      !!document.getElementById("rsTestChat") &&
      !!document.getElementById("rsCreatorAgent") &&
      document.getElementById("rsMaxConcurrency")?.value === "1" &&
      document.querySelectorAll(".rs-pane").length === 3;
  });
  roleStudio ? ok("角色统一编辑器（三栏同时保留）") : fail("角色统一编辑器未完整渲染");
  await page.evaluate(() => closeModal("roleStudioModal"));

  // 复制角色应打开一个新的创建草稿：沿用源角色的执行配置，但生成不冲突
  // 的副本名称；保存后再清理临时数据，避免污染 E2E 环境。
  const copyProbe = await page.evaluate(async () => {
    const all = await (await fetch("/api/agents")).json();
    if (!all.length) return { skipped: true };
    const source = all[0];
    await copyRole(source.id);
    const draft = {
      name: document.getElementById("rsName")?.value || "",
      cli: document.getElementById("rsCli")?.value || "",
      maxConcurrency: document.getElementById("rsMaxConcurrency")?.value || "",
      title: document.getElementById("roleStudioTitle")?.textContent || "",
      status: document.getElementById("roleStudioStatus")?.textContent || "",
      copyActionCount: document.querySelectorAll('[aria-label^="复制角色 "]').length,
      sourceName: source.name,
      sourceCLI: source.cli,
      sourceConcurrency: String(source.max_concurrency || 1),
    };
    const save = document.querySelector("#roleStudioModal .role-studio-head-actions .primary");
    if (!save) return { skipped: false, draft, created: null };
    await saveRoleStudio();
    return { skipped: false, draft };
  });
  if (copyProbe.skipped) ok("角色复制创建（无角色，跳过）");
  else {
    const copyDraftOK = copyProbe.draft.name !== copyProbe.draft.sourceName &&
      copyProbe.draft.name.includes("副本") &&
      copyProbe.draft.title.includes(copyProbe.draft.sourceName) &&
      copyProbe.draft.status.includes("复制草稿") &&
      copyProbe.draft.copyActionCount > 0 &&
      copyProbe.draft.cli === copyProbe.draft.sourceCLI &&
      copyProbe.draft.maxConcurrency === copyProbe.draft.sourceConcurrency;
    copyDraftOK ? ok("从现有角色打开复制草稿") : fail(`角色复制草稿不完整：${JSON.stringify(copyProbe.draft)}`);
    await page.waitForFunction(async name => {
      const all = await (await fetch("/api/agents")).json();
      return all.some(a => a.name === name);
    }, copyProbe.draft.name, { timeout: 6000 }).catch(() => {});
    const copied = await page.evaluate(async name => {
      const all = await (await fetch("/api/agents")).json();
      return all.find(a => a.name === name) || null;
    }, copyProbe.draft.name);
    if (copied) {
      const persisted = copied.cli === copyProbe.draft.sourceCLI &&
        Number(copied.max_concurrency || 1) === Number(copyProbe.draft.sourceConcurrency);
      persisted ? ok("角色副本保存配置") : fail(`角色副本配置未保存：${JSON.stringify(copied)}`);
      await page.evaluate(async id => {
        await fetch("/api/agents/" + id, { method: "DELETE" });
      }, copied.id);
      // loadAll 是 ES module 内部导出，不是模板全局函数；重新加载角色页
      // 走真实首屏初始化，避免清理逻辑依赖未公开的模块函数。
      await page.reload();
      await page.waitForTimeout(350);
    } else {
      fail("角色副本保存失败");
    }
  }
  await page.evaluate(() => closeModal("roleStudioModal"));

  // 从详情页复制后，保存应打开新副本详情，而不是留下旧角色详情壳。
  const detailCopyProbe = await page.evaluate(async () => {
    const all = await (await fetch("/api/agents")).json();
    if (!all.length) return { skipped: true };
    const source = all[0];
    const waitFor = check => new Promise(resolve => {
      const started = Date.now();
      const poll = () => {
        if (check() || Date.now() - started > 3000) return resolve();
        setTimeout(poll, 40);
      };
      poll();
    });
    openAgentDetail(source.id);
    await waitFor(() => document.getElementById("adCrumb")?.textContent.includes(source.name));
    await copyCurrentRole();
    const name = document.getElementById("rsName")?.value || "";
    await saveRoleStudio();
    await waitFor(() => !document.getElementById("agentDetailShell")?.classList.contains("hidden"));
    const created = (await (await fetch("/api/agents")).json()).find(a => a.name === name) || null;
    return {
      skipped: false,
      name,
      detailHidden: document.getElementById("agentDetailShell")?.classList.contains("hidden"),
      listHidden: document.getElementById("agentListShell")?.classList.contains("hidden"),
      crumb: document.getElementById("adCrumb")?.textContent || "",
      hash: location.hash,
      expectedHash: created ? `#/agent/${created.id}` : "",
    };
  });
  if (detailCopyProbe.skipped) ok("角色详情页复制（无角色，跳过）");
  else {
    const detailCopyOK = !detailCopyProbe.detailHidden && detailCopyProbe.listHidden &&
      detailCopyProbe.crumb.includes(detailCopyProbe.name) &&
      detailCopyProbe.hash === detailCopyProbe.expectedHash;
    detailCopyOK ? ok("角色详情页复制后打开新副本") : fail(`角色详情页复制后视图异常：${JSON.stringify(detailCopyProbe)}`);
    const copied = await page.evaluate(async name => {
      const all = await (await fetch("/api/agents")).json();
      return all.find(a => a.name === name) || null;
    }, detailCopyProbe.name);
    if (copied) {
      await page.evaluate(async id => { await fetch("/api/agents/" + id, { method: "DELETE" }); }, copied.id);
      await page.reload();
      await page.waitForTimeout(350);
    } else {
      fail("角色详情页复制副本保存失败");
    }
  }
  await page.evaluate(() => closeModal("roleStudioModal"));

  // 详情页编辑必须以当前详情角色为准。先打开角色 A 的工作台留下草稿，
  // 再切到角色 B；如果错误复用了旧的 roleStudio.agentID，这里会重新打开 A。
  const editorSwitch = await page.evaluate(async () => {
    const all = await (await fetch("/api/agents")).json();
    if (all.length < 2) return { skipped: true };
    const first = all[0], second = all[1];
    const waitFor = check => new Promise(resolve => {
      const started = Date.now();
      const poll = () => {
        if (check() || Date.now() - started > 3000) return resolve();
        setTimeout(poll, 40);
      };
      poll();
    });
    openAgentDetail(first.id);
    await waitFor(() => document.getElementById("adCrumb")?.textContent.includes(first.name));
    await openRoleStudio(first.id);
    closeModal("roleStudioModal");
    openAgentDetail(second.id);
    await waitFor(() => document.getElementById("adCrumb")?.textContent.includes(second.name));
    openCurrentRoleEditor();
    await waitFor(() => document.getElementById("rsName")?.value === second.name);
    return {
      skipped: false,
      title: document.getElementById("roleStudioTitle")?.textContent || "",
      name: document.getElementById("rsName")?.value || "",
      expectedName: second.name,
    };
  });
  if (editorSwitch.skipped) ok("角色详情切换后编辑（角色不足，跳过）");
  else if (editorSwitch.name === editorSwitch.expectedName && editorSwitch.title.includes(editorSwitch.expectedName)) ok("角色详情切换后打开正确编辑器");
  else fail(`角色详情切换后打开错误角色：${JSON.stringify(editorSwitch)}`);
  await page.evaluate(() => closeModal("roleStudioModal"));

  // 角色详情页内联并发编辑器：改值保存后 API 应持久化（先改再还原，不污染数据）
  const agents = await page.evaluate(async () => await (await fetch("/api/agents")).json());
  if (!agents.length) ok("角色详情页并发编辑器（无角色，跳过）");
  else {
    const a = agents[0];
    await page.evaluate(id => openAgentDetail(id), a.id);
    await page.waitForFunction(() => !!document.getElementById("aMaxConc"), null, { timeout: 6000 }).catch(() => {});
    const edited = await page.evaluate(id => {
      const inp = document.getElementById("aMaxConc");
      if (!inp) return false;
      const n = Number(inp.value) === 1 ? 2 : 1;
      inp.value = String(n);
      saveAgentConcurrency();
      return true;
    }, a.id);
    await page.waitForTimeout(1300);
    const expect = Number(a.max_concurrency || 1) === 1 ? 2 : 1;
    const persisted = edited && await page.evaluate(async id => {
      const all = await (await fetch("/api/agents")).json();
      return all.find(x => x.id === id)?.max_concurrency;
    }, a.id);
    persisted === expect ? ok("角色详情页修改并发数") : fail(`角色详情页并发修改未持久化：期望 ${expect}，得到 ${persisted}`);
    await page.evaluate(async id => {
      await fetch("/api/agents/" + id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ max_concurrency: 1 }) });
    }, a.id);
    await page.evaluate(() => closeAgentDetail());
  }

  // 详情页删除按钮通过内联 onclick 触发。它不能直接引用 ES module 内的
  // state，故创建临时角色后从详情页点击删除，验证完整的浏览器事件链路。
  const deleteProbe = await page.evaluate(async () => {
    const r = await fetch("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "e2e 删除验证 " + Date.now(), cli: "pi", enabled: true }),
    });
    return r.ok ? await r.json() : null;
  });
  if (!deleteProbe) fail("创建角色删除验证数据失败");
  else {
    // 通过 HTTP 创建的临时角色不会立刻写入页面内存 state，先刷新确保以下
    // 点击走的是真实渲染出的前端按钮。
    await page.reload();
    await page.waitForTimeout(700);
    await page.evaluate(id => openAgentDetail(id), deleteProbe.id);
    await page.waitForFunction(() => !document.getElementById("agentDetailShell").classList.contains("hidden"),
      null, { timeout: 6000 }).catch(() => {});
    page.once("dialog", dialog => dialog.accept());
    await page.locator("#agentDetailShell .btn.danger").click();
    await page.waitForFunction(async id => {
      const all = await (await fetch("/api/agents")).json();
      return !all.some(a => a.id === id);
    }, deleteProbe.id, { timeout: 6000 }).catch(() => {});
    const deleted = await page.evaluate(async id => {
      const all = await (await fetch("/api/agents")).json();
      return !all.some(a => a.id === id) && document.getElementById("agentDetailShell").classList.contains("hidden");
    }, deleteProbe.id);
    deleted ? ok("角色详情页删除按钮") : fail("角色详情页删除按钮未删除角色");
  }

  // 卡片删除按钮需要阻止卡片自身的“打开详情”点击事件，并把正确的角色 ID
  // 传给删除请求。单独用临时角色覆盖这条事件链路。
  const cardDeleteProbe = await page.evaluate(async () => {
    const r = await fetch("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "e2e 卡片删除验证 " + Date.now(), cli: "pi", enabled: true }),
    });
    return r.ok ? await r.json() : null;
  });
  if (!cardDeleteProbe) fail("创建卡片删除验证数据失败");
  else {
    await page.reload();
    await page.waitForTimeout(700);
    await page.evaluate(() => setAgentView("grid"));
    await page.waitForFunction(id =>
      !!document.querySelector(`.agent-card[data-agent-id="${id}"] .btn.danger`), cardDeleteProbe.id,
      { timeout: 6000 }).catch(() => {});
    page.once("dialog", dialog => dialog.accept());
    await page.locator(`.agent-card[data-agent-id="${cardDeleteProbe.id}"] .btn.danger`).click();
    await page.waitForFunction(async id => {
      const all = await (await fetch("/api/agents")).json();
      return !all.some(a => a.id === id);
    }, cardDeleteProbe.id, { timeout: 6000 }).catch(() => {});
    const deleted = await page.evaluate(async id => {
      const all = await (await fetch("/api/agents")).json();
      return !all.some(a => a.id === id) &&
        !document.querySelector(`.agent-card[data-agent-id="${id}"]`) &&
        document.getElementById("agentDetailShell").classList.contains("hidden");
    }, cardDeleteProbe.id);
    deleted ? ok("角色卡片删除按钮") : fail("角色卡片删除按钮未删除角色");
  }

  // 角色创建的选项与角色页同源：schema 字段必须带 builtin 标记（Go 侧从
  // RoleConfig 反射派生），前端据此决定读写位置，新增/删除选项自动同步。
  const schemaSync = await page.evaluate(async () => {
    const schema = await (await fetch("/api/agents/schema")).json();
    if (!schema.every(s => (s.fields || []).every(f => typeof f.builtin === "boolean"))) return false;
    const pi = schema.find(s => s.id === "pi");
    return pi.fields.find(f => f.key === "model")?.builtin === true &&
      pi.fields.find(f => f.key === "provider")?.builtin === false;
  });
  schemaSync ? ok("schema 字段 builtin 标记（创建选项与角色页同源）") : fail("schema 字段 builtin 标记异常");

  await page.goto(URL + "/board");
  await page.waitForTimeout(700);
  const boardAreas = await page.evaluate(() => {
    const heads = [...document.querySelectorAll(".board-section-head h2")].map(x => x.textContent.trim());
    return heads.includes("实现任务") && heads.includes("代码合并") && document.querySelectorAll(".board-section").length === 2;
  });
  boardAreas ? ok("看板区分实现任务与代码合并") : fail("看板未分区显示实现任务与代码合并");
  await page.evaluate(() => openNewTask());
  await page.waitForTimeout(350);
  const taskModal = await page.evaluate(() =>
    !document.getElementById("taskModal").classList.contains("hidden") &&
    document.getElementById("tRunMode")?.value === "batch");
  taskModal ? ok("任务弹窗（默认批处理）") : fail("任务弹窗未打开或默认执行方式异常");
  if (process.env.E2E_EXPECT_INTERACTIVE === "1") {
    const interactive = await page.evaluate(async () => {
      const agents = await (await fetch("/api/agents")).json();
      const target = agents.find(a => a.enabled && a.cli !== "pi") || agents.find(a => a.enabled);
      const agent = document.getElementById("tAgent");
      const optionForAgent = target && [...agent.options].find(o => Number(o.value) === target.id);
      if (!optionForAgent) return false;
      agent.value = optionForAgent.value;
      syncTaskRunMode();
      const mode = document.getElementById("tRunMode");
      const option = mode.querySelector('option[value="interactive"]');
      mode.value = "interactive";
      return !option.disabled && mode.value === "interactive";
    });
    interactive ? ok("角色手工交互方式") : fail("角色交互方式未启用");
  }
  await page.evaluate(() => closeModal("taskModal"));

  await page.goto(URL + "/projects");
  await page.waitForTimeout(700);
  await page.setViewportSize({ width: 320, height: 812 });
  const mobileProjectSearch = await page.evaluate(() => {
    const toolbar = document.querySelector(".project-toolbar");
    const search = document.getElementById("pSearch");
    const count = document.getElementById("projectCount");
    if (!toolbar || !search || !count) return null;
    const toolbarRect = toolbar.getBoundingClientRect();
    const searchRect = search.getBoundingClientRect();
    const countRect = count.getBoundingClientRect();
    return {
      noOverflow: document.documentElement.scrollWidth <= innerWidth && searchRect.left >= 0 && countRect.right <= innerWidth,
      searchHeight: searchRect.height,
      topInset: searchRect.top - toolbarRect.top,
      bottomInset: toolbarRect.bottom - searchRect.bottom,
      sameRow: Math.abs((searchRect.top + searchRect.height / 2) - (countRect.top + countRect.height / 2)) <= 1,
    };
  });
  const mobileProjectSearchOK = mobileProjectSearch && mobileProjectSearch.noOverflow &&
    mobileProjectSearch.searchHeight >= 40 && mobileProjectSearch.searchHeight <= 44 &&
    mobileProjectSearch.topInset >= 6 && mobileProjectSearch.bottomInset >= 6 && mobileProjectSearch.sameRow;
  mobileProjectSearchOK ? ok("项目搜索框移动端布局") : fail(`项目搜索框移动端布局异常：${JSON.stringify(mobileProjectSearch)}`);
  await page.setViewportSize({ width: W, height: H });
  await page.evaluate(() => openProjectModal());
  await page.waitForTimeout(300);
  await page.locator("#projectModal .dir-input-row .btn").click();
  await page.waitForTimeout(500);
  const dir = await page.evaluate(() => {
    const m = document.getElementById("dirModal");
    const parent = document.getElementById("projectModal");
    const label = document.getElementById(m.getAttribute("aria-labelledby"));
    return !m.classList.contains("hidden") &&
      m.getAttribute("role") === "dialog" && m.getAttribute("aria-modal") === "true" &&
      !!label?.textContent.trim() && m.contains(document.activeElement) &&
      parent.getAttribute("aria-hidden") === "true" &&
      document.querySelectorAll("#dirList > .dir-row").length > 0 &&
      [...document.querySelectorAll("#dirList > .dir-row")].every(el => el.tagName === "BUTTON");
  });
  dir ? ok("项目弹窗 + 可访问目录选择器") : fail("项目弹窗/目录选择器异常");
  await page.keyboard.press("Escape");
  const nestedModalReturn = await page.evaluate(() => {
    const parent = document.getElementById("projectModal");
    return document.getElementById("dirModal").classList.contains("hidden") &&
      !parent.classList.contains("hidden") && parent.getAttribute("aria-hidden") === "false" &&
      parent.contains(document.activeElement);
  });
  nestedModalReturn ? ok("嵌套弹窗关闭后恢复焦点") : fail("嵌套弹窗关闭或焦点恢复异常");
  await page.keyboard.press("Escape");

  // 项目页直接派活：详情页新建任务按钮 → 弹窗预选项目（真实走 API 建/删，验证完整链路）
  const proj = await page.evaluate(async () => {
    const r = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "e2e 派活验证项目名称很长时页头操作按钮仍然保持在同一行且项目名称自动省略显示",
        description: "", project_dir: "", status: "active",
      }),
    });
    return r.ok ? await r.json() : null;
  });
  if (!proj) fail("创建测试项目失败");
  else {
    // 先跳到别的路径再带 hash 进详情：同路径仅 hash 差异时 goto 是同一文档导航（不重载），
    // state.projects 会是旧数据（不含刚建的项目），详情页会静默空白。
    await page.goto(URL + "/board");
    await page.goto(URL + "/projects#/project/" + proj.id);
    // 等待详情页真正渲染完成（loadAll → route → refreshProjectDetail 是异步链，CLI 探测可能慢）
    await page.waitForFunction(id => {
      const d = document.getElementById("projectDetailShell");
      if (!d || d.classList.contains("hidden")) return false;
      const b = document.querySelector("#pdMain .btn");
      return b && b.textContent.includes("新建任务");
    }, proj.id, { timeout: 10000 }).catch(() => {});
    const btn = await page.evaluate(() => {
      const b = [...document.querySelectorAll("#pdMain .btn")].find(x => x.textContent.includes("新建任务"));
      const d = document.getElementById("projectDetailShell");
      return { has: !!b, detail: d && !d.classList.contains("hidden"), mergeArea: document.getElementById("pdMain")?.textContent.includes("代码合并") };
    });
    btn.has && btn.detail ? ok("项目详情页新建任务按钮") : fail("项目详情页无新建任务入口");
    btn.mergeArea ? ok("项目页区分代码合并任务") : fail("项目页未显示代码合并分区");
    await page.setViewportSize({ width: 320, height: 812 });
    const longProjectHeader = await page.evaluate(() => {
      const header = document.querySelector("#projectDetailShell > .page-header");
      const crumb = document.getElementById("pdCrumb");
      const name = crumb?.querySelector("b");
      const badge = document.getElementById("pdBadge");
      const deleteButton = [...(header?.querySelectorAll(":scope > .btn") || [])]
        .find(button => button.textContent.trim() === "删除");
      if (!header || !crumb || !name || !badge || !deleteButton) return null;
      const headerRect = header.getBoundingClientRect();
      const crumbRect = crumb.getBoundingClientRect();
      const badgeRect = badge.getBoundingClientRect();
      const deleteRect = deleteButton.getBoundingClientRect();
      const centerY = rect => rect.top + rect.height / 2;
      return {
        sameRow: Math.max(centerY(crumbRect), centerY(badgeRect), centerY(deleteRect)) -
          Math.min(centerY(crumbRect), centerY(badgeRect), centerY(deleteRect)) <= 1,
        deleteVisible: deleteRect.right <= headerRect.right + 1 && deleteRect.right <= innerWidth,
        clippedName: name.scrollWidth > name.clientWidth && getComputedStyle(name).textOverflow === "ellipsis",
        noOverflow: document.documentElement.scrollWidth <= innerWidth,
      };
    });
    const longProjectHeaderOK = longProjectHeader && Object.values(longProjectHeader).every(Boolean);
    longProjectHeaderOK ? ok("项目详情页长名称不挤压删除按钮") :
      fail(`项目详情页长名称布局异常：${JSON.stringify(longProjectHeader)}`);
    await page.setViewportSize({ width: W, height: H });
    await page.evaluate(id => openProjectTask(id), proj.id);
    await page.waitForTimeout(350);
    const pre = await page.evaluate(id => {
      const m = document.getElementById("taskModal");
      return !m.classList.contains("hidden") && Number(document.getElementById("tProject")?.value) === id;
    }, proj.id);
    pre ? ok("项目页直接派活（弹窗预选项目）") : fail("项目页派活弹窗未预选项目");
    await page.evaluate(() => closeModal("taskModal"));
    await page.evaluate(async id => {
      await fetch("/api/projects/" + id, { method: "DELETE" });
    }, proj.id);
  }

  await page.goto(URL + "/agents");
  // 首次检测会逐个探测本机 CLI，慢机器或某个 CLI 超时也不应让回归误判。
  await page.waitForFunction(() => document.querySelectorAll(".prov-card").length > 0, null, { timeout: 12000 }).catch(() => {});
  const prov = await page.evaluate(() => document.querySelectorAll(".prov-card").length);
  prov > 0 ? ok(`安装面板（${prov} 张卡片）`) : fail("安装面板未渲染");
  // 动态按钮回归：JS 字符串生成的 onclick 必须挂到 window（防 installProvision is not defined 类回归）
  const dyn = await page.evaluate(() => ({
    install: typeof window.installProvision === "function",
    createRole: typeof window.createDefaultRole === "function",
    setTaskStatus: typeof window.setTaskStatus === "function",
    openTask: typeof window.openTask === "function",
    wsDiscard: typeof window.wsDiscard === "function",
    resumeTask: typeof window.resumeTask === "function",
  }));
  Object.values(dyn).every(Boolean) ? ok("动态按钮全局函数（6 项）") : fail("动态按钮全局函数缺失: " + JSON.stringify(dyn));
  const dynBtn = await page.evaluate(() =>
    [...document.querySelectorAll(".prov-actions .btn")].some(b => b.textContent.includes("重装/更新")));
  dynBtn ? ok("重装/更新按钮渲染") : fail("重装/更新按钮缺失");

  await page.goto(URL + "/autopilots");
  await page.waitForTimeout(700);
  await page.evaluate(() => openScheduleModal());
  await page.waitForTimeout(300);
  const sched = await page.evaluate(() =>
    !document.getElementById("scheduleModal").classList.contains("hidden") &&
    document.getElementById("sPerm")?.value === "full" &&
    !document.getElementById("sCron") &&
    document.getElementById("sFrequency")?.value === "daily" &&
    document.getElementById("sTime")?.value === "09:00");
  sched ? ok("定时任务弹窗（周期/日期/时间选项）") : fail("定时任务弹窗未提供周期/日期/时间选项");
  const scheduleRule = await page.evaluate(async () => {
    document.getElementById("sFrequency").value = "weekly";
    document.getElementById("sWeekday").value = "3";
    document.getElementById("sTime").value = "14:30";
    syncScheduleFields();
    let payload = null;
    const originalFetch = window.fetch;
    window.fetch = async (url, opts) => {
      if (String(url).includes("/api/schedules")) {
        payload = JSON.parse(opts.body);
        throw new Error("capture schedule payload");
      }
      return originalFetch(url, opts);
    };
    try { await submitSchedule(); } finally { window.fetch = originalFetch; }
    return payload;
  });
  scheduleRule?.cron === "0 30 14 * * 3"
    ? ok("定时任务选项生成执行规则")
    : fail("定时任务选项未生成预期执行规则: " + JSON.stringify(scheduleRule));
  await page.evaluate(() => closeModal("scheduleModal"));

  await page.goto(URL + "/skills");
  await page.waitForTimeout(600);
  await page.evaluate(() => setSkillTab("ext"));
  await page.waitForTimeout(600);
  const ext = await page.evaluate(() => document.querySelector(".seg .active")?.textContent || "");
  ext.includes("扩展") ? ok("技能/扩展双 tab") : fail("双 tab 切换异常");

  // Skills 外层必须占满 page-content 的剩余高度，否则内层列表会被内容撑开，
  // 在可视区外被裁切而无法滚动。逐步填充卡片，适配不同的测试视口尺寸。
  const skillsScrollable = await page.evaluate(() => {
    setSkillTab("skills");
    const grid = document.getElementById("skillGrid");
    let count = 40;
    do {
      grid.innerHTML = Array.from({ length: count }, (_, i) =>
        `<div class="skill-card"><div class="sk-name">滚动验证技能 ${i + 1}</div><div class="sk-desc">用于验证 Skills 列表不会被裁切。</div></div>`
      ).join("");
      count *= 2;
    } while (grid.scrollHeight <= grid.clientHeight && count <= 1280);
    grid.scrollTop = 200;
    return grid.scrollHeight > grid.clientHeight && grid.scrollTop > 0;
  });
  skillsScrollable ? ok("技能列表可滚动") : fail("技能列表被裁切或不可滚动");

  // 汇总
  console.log("— 汇总 —");
  if (errors.length) { failed = true; errors.slice(0, 10).forEach(e => console.log("  ✗ " + e)); }
  if (failed) { console.log("E2E FAILED"); process.exitCode = 1; }
  else console.log("E2E PASS：全部页面与交互无错误、无溢出");
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
