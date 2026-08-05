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
const PAGES = ["/", "/board", "/roles", "/agents", "/projects", "/skills", "/history", "/settings", "/autopilots"];

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

  // 2) 关键交互
  console.log("— 交互回归 —");
  await page.goto(URL + "/roles");
  await page.waitForTimeout(700);
  await page.evaluate(() => setAgentView("table"));
  await page.evaluate(() => openAgentModal());
  await page.waitForTimeout(350);
  const agentModal = await page.evaluate(() =>
    !document.getElementById("agentModal").classList.contains("hidden") &&
    !document.getElementById("aPerm") &&
    document.getElementById("aMaxConcurrency")?.value === "1");
  agentModal ? ok("角色弹窗（默认单并发）") : fail("角色弹窗未打开或默认最大并发异常");
  await page.evaluate(() => closeModal("agentModal"));

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
  await page.evaluate(() => openNewTask());
  await page.waitForTimeout(350);
  const taskModal = await page.evaluate(() =>
    !document.getElementById("taskModal").classList.contains("hidden") &&
    document.getElementById("tRunMode")?.value === "batch");
  taskModal ? ok("任务弹窗（默认批处理）") : fail("任务弹窗未打开或默认执行方式异常");
  if (process.env.E2E_EXPECT_INTERACTIVE === "1") {
    const interactive = await page.evaluate(() => {
      const agent = document.getElementById("tAgent");
      const pi = [...agent.options].find(o => o.textContent.includes("Pi smoke"));
      if (!pi) return false;
      agent.value = pi.value;
      syncTaskRunMode();
      const mode = document.getElementById("tRunMode");
      const option = mode.querySelector('option[value="interactive"]');
      mode.value = "interactive";
      return !option.disabled && mode.value === "interactive";
    });
    interactive ? ok("Pi 手工交互方式") : fail("Pi 交互方式未启用");
  }
  await page.evaluate(() => closeModal("taskModal"));

  await page.goto(URL + "/projects");
  await page.waitForTimeout(700);
  await page.evaluate(() => openProjectModal());
  await page.waitForTimeout(300);
  await page.evaluate(() => openDirPicker("pProjectDir"));
  await page.waitForTimeout(500);
  const dir = await page.evaluate(() => {
    const m = document.getElementById("dirModal");
    return !m.classList.contains("hidden") && document.querySelectorAll("#dirList > div").length > 0;
  });
  dir ? ok("项目弹窗 + 目录选择器") : fail("项目弹窗/目录选择器异常");
  await page.evaluate(() => closeModal("dirModal"));
  await page.evaluate(() => closeModal("projectModal"));

  // 项目页直接派活：详情页新建任务按钮 → 弹窗预选项目（真实走 API 建/删，验证完整链路）
  const proj = await page.evaluate(async () => {
    const r = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "e2e 派活验证", description: "", project_dir: "", status: "active" }),
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
      return { has: !!b, detail: d && !d.classList.contains("hidden") };
    });
    btn.has && btn.detail ? ok("项目详情页新建任务按钮") : fail("项目详情页无新建任务入口");
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
    wsMerge: typeof window.wsMerge === "function",
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
    !document.getElementById("scheduleModal").classList.contains("hidden") && document.getElementById("sPerm")?.value === "full");
  sched ? ok("定时任务弹窗") : fail("定时任务弹窗未打开");
  await page.evaluate(() => closeModal("scheduleModal"));

  await page.goto(URL + "/skills");
  await page.waitForTimeout(600);
  await page.evaluate(() => setSkillTab("ext"));
  await page.waitForTimeout(600);
  const ext = await page.evaluate(() => document.querySelector(".seg .active")?.textContent || "");
  ext.includes("扩展") ? ok("技能/扩展双 tab") : fail("双 tab 切换异常");

  // 汇总
  console.log("— 汇总 —");
  if (errors.length) { failed = true; errors.slice(0, 10).forEach(e => console.log("  ✗ " + e)); }
  if (failed) { console.log("E2E FAILED"); process.exitCode = 1; }
  else console.log("E2E PASS：全部页面与交互无错误、无溢出");
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
