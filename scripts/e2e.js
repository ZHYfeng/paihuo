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

  const routes = ["/board", "/sessions", "/workflows", "/history", "/projects", "/roles", "/runtimes", "/skills", "/templates", "/schedules", "/settings"];
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
  await page.evaluate(async item => {
    const response = await fetch(`/api/v1/projects/${item.id}`, { method: "DELETE", headers: { "If-Match": `"${item.revision}"`, "Idempotency-Key": crypto.randomUUID() } });
    if (!response.ok) throw new Error(await response.text());
  }, project);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseURL + "/board", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "打开导航" }).click();
  await page.getByRole("navigation", { name: "主导航" }).waitFor();
  if (await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)) throw new Error("mobile viewport overflows");

  if (errors.length) throw new Error(`browser errors:\n${errors.join("\n")}`);
  console.log("React routes, API concurrency contract, and responsive shell ✓");
} finally {
  await browser.close();
}
