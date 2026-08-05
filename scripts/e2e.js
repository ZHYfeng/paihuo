// 端到端回归（由 scripts/e2e.sh 调用）：
// 1) 登录 → 遍历全部页面，收集 pageerror/console.error 与横向溢出
// 2) 关键交互：角色弹窗、任务弹窗、项目弹窗 + 目录选择器、安装面板、技能双 tab
// 退出码：0 = 全部通过；1 = 有错误
const { chromium } = require("playwright-core");
const path = require("path");
const os = require("os");

const URL = process.env.E2E_URL || "http://127.0.0.1:8099";
const TOKEN = process.env.E2E_TOKEN || "t";
const [W, H] = (process.env.E2E_VIEWPORT || "1440x900").split("x").map(Number);
const PAGES = ["/", "/board", "/roles", "/agents", "/projects", "/skills", "/history", "/settings", "/autopilots"];

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
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
  const agentModal = await page.evaluate(() => !document.getElementById("agentModal").classList.contains("hidden"));
  agentModal ? ok("角色弹窗") : fail("角色弹窗未打开");
  await page.evaluate(() => closeModal("agentModal"));

  await page.goto(URL + "/board");
  await page.waitForTimeout(700);
  await page.evaluate(() => openNewTask());
  await page.waitForTimeout(350);
  const taskModal = await page.evaluate(() => !document.getElementById("taskModal").classList.contains("hidden"));
  taskModal ? ok("任务弹窗") : fail("任务弹窗未打开");
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

  await page.goto(URL + "/agents");
  await page.waitForTimeout(2000);
  const prov = await page.evaluate(() => document.querySelectorAll(".prov-card").length);
  prov > 0 ? ok(`安装面板（${prov} 张卡片）`) : fail("安装面板未渲染");

  await page.goto(URL + "/autopilots");
  await page.waitForTimeout(700);
  await page.evaluate(() => openScheduleModal());
  await page.waitForTimeout(300);
  const sched = await page.evaluate(() => !document.getElementById("scheduleModal").classList.contains("hidden"));
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
