import { chromium } from "playwright";

const baseURL = process.env.E2E_URL || "http://127.0.0.1:8099";
const token = process.env.E2E_TOKEN || "t";
const [width, height] = (process.env.E2E_VIEWPORT || "1440x900").split("x").map(Number);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width, height } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });

try {
  await page.goto(baseURL, { waitUntil: "domcontentloaded" });
  if (new URL(page.url()).pathname === "/login") {
    await page.getByLabel("访问令牌").fill(token);
    await Promise.all([page.waitForURL(url => url.pathname === "/"), page.getByRole("button", { name: /进入工作台/ }).click()]);
  }
  await page.getByRole("heading", { name: "工作台" }).waitFor();
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: "切换到暗色" }).click();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "切换到亮色" }).waitFor();
  if (!await page.evaluate(() => document.documentElement.classList.contains("dark"))) throw new Error("theme preference was not restored");
  await page.getByRole("button", { name: "切换到亮色" }).click();

  const routes = ["/board", "/approvals", "/sessions", "/workflows", "/history", "/projects", "/roles", "/runtimes", "/skills", "/templates", "/schedules", "/settings"];
  for (const route of routes) {
    await page.goto(baseURL + route, { waitUntil: "domcontentloaded" });
    await page.locator("#main-content h1").waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    if (overflow) throw new Error(`${route} has horizontal page overflow`);
  }

  const project = await page.evaluate(async name => {
    const response = await fetch("/api/v1/projects", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ name, description: "Playwright contract", project_dir: "" }) });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }, `e2e-${Date.now()}`);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "搜索任务、项目或页面" }).waitFor();
  await page.keyboard.press("Control+k");
  await page.getByRole("textbox", { name: "搜索工作空间内容" }).fill(project.name);
  const [statsResponse] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/stats/projects/${project.id}`),
    page.getByRole("dialog").getByRole("link", { name: project.name, exact: true }).click()
  ]);
  if (!statsResponse.ok()) throw new Error(`project stats failed: ${statsResponse.status()}`);
  await page.getByRole("heading", { name: project.name }).waitFor();
  await page.getByRole("heading", { name: "任务", exact: true }).waitFor();
  await page.evaluate(async item => {
    const response = await fetch(`/api/v1/projects/${item.id}/tasks/order`, { method: "PUT", headers: { "Content-Type": "application/json", "If-Match": `"${item.revision}"`, "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ task_ids: [] }) });
    if (!response.ok) throw new Error(await response.text());
  }, project);
  await page.evaluate(async item => {
    const response = await fetch(`/api/v1/projects/${item.id}`, { method: "DELETE", headers: { "If-Match": `"${item.revision}"`, "Idempotency-Key": crypto.randomUUID() } });
    if (!response.ok) throw new Error(await response.text());
  }, project);

  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of ["/", ...routes]) {
    await page.goto(baseURL + route, { waitUntil: "domcontentloaded" });
    await page.locator("#main-content h1").waitFor();
    if (await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)) throw new Error(`mobile ${route} overflows`);
  }
  await page.goto(baseURL + "/board", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "打开导航" }).click();
  await page.getByRole("navigation", { name: "主导航" }).waitFor();
  if (await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)) throw new Error("mobile viewport overflows");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "打开导航" }).click();
  await page.getByRole("navigation", { name: "主导航" }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "新建任务" }).click();
  await page.getByRole("dialog", { name: "新建任务" }).waitFor();
  if (await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)) throw new Error("mobile task dialog overflows");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "搜索任务、项目或页面" }).click();
  await page.getByRole("textbox", { name: "搜索工作空间内容" }).fill("审批");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("n");
  if (await page.getByRole("dialog").count() !== 1) throw new Error("task shortcut opened another dialog during search");
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "审批", exact: true }).waitFor();

  if (errors.length) throw new Error(`browser errors:\n${errors.join("\n")}`);
  console.log("React routes (desktop/mobile), search, theme persistence, dialogs, and API concurrency contract ✓");
} finally {
  await browser.close();
}
