// Targeted regression for the live interactive terminal geometry.
// Run against a local PaiHuo server with:
//   E2E_URL=http://127.0.0.1:18099 E2E_TOKEN=t node scripts/terminal-layout.e2e.js
const fs = require("fs");
const os = require("os");
const path = require("path");

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (_) {
  ({ chromium } = require("playwright-core"));
}

const BASE_URL = process.env.E2E_URL || "http://127.0.0.1:18099";
const TOKEN = process.env.E2E_TOKEN || "t";
const TASK_ID = 91001;
const TEST_CASE = process.env.E2E_CASE || "all";
const [VIEWPORT_WIDTH, VIEWPORT_HEIGHT] = (process.env.E2E_VIEWPORT || "1440x900").split("x").map(Number);
const DEVICE_SCALE_FACTOR = Number(process.env.E2E_DSF || 2);

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const bundled = chromium.executablePath();
  if (bundled && fs.existsSync(bundled)) return bundled;
  const base = path.join(os.homedir(), ".cache", "ms-playwright");
  const candidates = [];
  for (const dir of fs.readdirSync(base)) {
    for (const rel of [
      "chrome-linux64/chrome",
      "chrome-linux/chrome",
      "chrome-headless-shell-linux64/chrome-headless-shell",
    ]) {
      const candidate = path.join(base, dir, rel);
      try {
        if (fs.statSync(candidate).isFile()) candidates.push(candidate);
      } catch (_) {}
    }
  }
  if (!candidates.length) throw new Error("Chromium not found");
  return candidates.sort().pop();
}

const task = {
  id: TASK_ID,
  title: "terminal geometry probe",
  body: "keep the interactive pane aligned with its tmux window",
  status: TEST_CASE === "replay-width" ? "succeeded" : "running",
  run_mode: "interactive",
  perm: "full",
  agent_id: 501,
  agent_name: "terminal-probe",
  project_dir: "/tmp",
  created_at: "2026-08-07T12:00:00Z",
  terminal_cols: TEST_CASE === "replay-width" ? 86 : 80,
  // Keep the replay frame short enough that horizontal fit is the limiting
  // axis. This catches padding that is accidentally omitted from width math.
  terminal_rows: TEST_CASE === "replay-width" ? 10 : 24,
};
const agent = { id: 501, name: "terminal-probe", cli: "pi", enabled: true, max_concurrency: 1 };

function json(route, value, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
}

function terminalBoxSnapshot() {
  const read = host => {
    const screen = host?.querySelector(".xterm-screen");
    const viewport = host?.querySelector(".xterm-viewport");
    const canvas = host?.querySelector("canvas");
    if (!host || !screen) return null;
    const h = host.getBoundingClientRect();
    const s = screen.getBoundingClientRect();
    const v = viewport?.getBoundingClientRect();
    return {
      host: { width: h.width, height: h.height },
      screen: { width: s.width, height: s.height },
      viewport: v ? { width: v.width, height: v.height } : null,
      canvas: canvas ? {
        cssWidth: canvas.getBoundingClientRect().width,
        cssHeight: canvas.getBoundingClientRect().height,
        width: canvas.width,
        height: canvas.height,
      } : null,
    };
  };
  return {
    inline: read(document.getElementById("taskTermX")),
    fullscreen: read(document.getElementById("termX")),
    detail: (() => {
      const r = document.getElementById("detailShell")?.getBoundingClientRect();
      return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    })(),
  };
}

(async () => {
  const browser = await chromium.launch({ executablePath: findChrome() });
  const page = await browser.newPage({
    viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
  });
  page.setDefaultTimeout(5000);
  const resizeReports = [];
  const inputReports = [];
  const pageErrors = [];
  let releaseLiveLog;
  const liveLogGate = new Promise(resolve => { releaseLiveLog = resolve; });
  const initialLog = {
    id: 1, task_id: TASK_ID, seq: 1, stream: "term",
    content: TEST_CASE === "replay-width"
      ? `\x1b[2J\x1b[H${".".repeat(85)}R`
      : "\uf0e7 OMP terminal probe> ",
  };
  const echoedLog = { id: 2, task_id: TASK_ID, seq: 2, stream: "term", content: "typed" };
  page.on("pageerror", error => pageErrors.push(error.message));

  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    if (pathname === `/api/tasks/${TASK_ID}/resize`) {
      resizeReports.push(JSON.parse(request.postData() || "{}"));
      return json(route, {});
    }
    if (pathname === `/api/tasks/${TASK_ID}/input`) {
      inputReports.push(JSON.parse(request.postData() || "{}"));
      return json(route, {});
    }
    if (pathname === "/api/tasks") return json(route, [task]);
    if (pathname === `/api/tasks/${TASK_ID}`) return json(route, task);
    if (pathname === `/api/tasks/${TASK_ID}/logs`) {
      return json(route, { logs: [initialLog], has_more: false, total: 1 });
    }
    if (pathname === `/api/tasks/${TASK_ID}/children`) return json(route, []);
    if (pathname === `/api/workspace/${TASK_ID}`) return json(route, { is_git: false, path: "/tmp" });
    if (pathname === "/api/agents") return json(route, [agent]);
    if (pathname === "/api/agents/schema") return json(route, []);
    if (pathname === "/api/schedules" || pathname === "/api/projects" || pathname === "/api/templates") return json(route, []);
    if (pathname === "/api/stats/overview") {
      return json(route, { status_counts: [], daily: [], in_flight: 1, success_rate: 0, avg_duration: 0, projects: 0 });
    }
    if (pathname === "/api/events") {
      await liveLogGate;
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "Cache-Control": "no-cache" },
        body: `event: log\ndata: ${JSON.stringify({ payload: echoedLog })}\n\n`,
      });
    }
    return json(route, {});
  });

  try {
    await page.goto(`${BASE_URL}/login`);
    await page.fill("input[type=password]", TOKEN);
    await page.click("button[type=submit]");
    await page.waitForURL(url => !url.pathname.includes("login"));
    await page.goto(`${BASE_URL}/board#/issue/${TASK_ID}`);
    if (TEST_CASE === "replay-width") {
      await page.waitForSelector("details.task-log-section");
      await page.click("details.task-log-section > summary");
    }
    await page.waitForSelector("#taskTermX .xterm-screen");
    await page.waitForTimeout(500);

    if (TEST_CASE === "replay-width") {
      await page.waitForFunction(() => document.querySelector("#taskTermX .xterm-rows")?.textContent.includes("R"));
      await page.waitForTimeout(700);
      const replayProbe = await page.evaluate(() => {
        const host = document.getElementById("taskTermX");
        const screen = host?.querySelector(".xterm-screen");
        const rows = [...(host?.querySelector(".xterm-rows")?.children || [])];
        const edgeRow = rows.find(row => row.textContent?.includes("R"));
        const markerNode = [...(edgeRow?.childNodes || [])]
          .flatMap(node => node.nodeType === Node.TEXT_NODE ? [node] : [...node.childNodes])
          .find(node => node.textContent?.includes("R"));
        let marker = null;
        if (markerNode) {
          const index = markerNode.textContent.lastIndexOf("R");
          const range = document.createRange();
          range.setStart(markerNode, index);
          range.setEnd(markerNode, index + 1);
          const r = range.getBoundingClientRect();
          marker = { left: r.left, right: r.right, width: r.width };
        }
        const rect = element => {
          const r = element?.getBoundingClientRect();
          return r ? { left: r.left, right: r.right, width: r.width } : null;
        };
        return {
          host: rect(host), screen: rect(screen), marker,
          edgeText: edgeRow?.textContent || "",
          transform: screen?.parentElement ? getComputedStyle(screen.parentElement).transform : "",
        };
      });
      console.log(JSON.stringify({ replayProbe }, null, 2));
      const tolerance = 1;
      const markerVisible = replayProbe.marker && replayProbe.host &&
        replayProbe.marker.left >= replayProbe.host.left - tolerance &&
        replayProbe.marker.right <= replayProbe.host.right + tolerance;
      if (!markerVisible) {
        console.error(`FAIL: archived terminal column 86 is clipped: ${JSON.stringify(replayProbe)}`);
        process.exitCode = 1;
      } else {
        console.log("PASS: archived terminal rightmost column remains visible");
      }
      return;
    }

    await page.click("#taskTermX");
    await page.keyboard.type("typed");
    await page.waitForFunction(() => document.activeElement?.classList.contains("xterm-helper-textarea"));
    await page.waitForTimeout(150);
    releaseLiveLog();
    await page.waitForFunction(() => document.querySelector("#taskTermX .xterm-rows")?.textContent.includes("typed"));
    const streamProbe = await page.evaluate(() => ({
      text: document.querySelector("#taskTermX .xterm-rows")?.textContent || "",
      lines: [...document.querySelectorAll("#taskTermX .xterm-rows > div")].map(row => row.textContent || ""),
    }));

    const before = await page.evaluate(terminalBoxSnapshot);
    const fontProbe = await page.evaluate(async () => {
      await document.fonts.ready;
      const rows = document.querySelector("#taskTermX .xterm-rows");
      return {
        stack: rows ? getComputedStyle(rows).fontFamily : "",
        letterSpacing: rows ? Number.parseFloat(getComputedStyle(rows).letterSpacing) || 0 : 0,
        glyphPresent: Boolean(rows?.textContent.includes("\uf0e7")),
        nerdFaces: [...document.fonts]
          .filter(face => /nerd/i.test(face.family))
          .map(face => ({ family: face.family, status: face.status })),
      };
    });
    const fontErrors = [];
    if (!fontProbe.glyphPresent) fontErrors.push("Nerd Font fixture glyph did not reach xterm");
    if (!/nerd/i.test(fontProbe.stack) || !fontProbe.nerdFaces.some(face => face.status === "loaded")) {
      fontErrors.push(`xterm has no loaded Nerd Font face: ${JSON.stringify(fontProbe)}`);
    }
    if (Math.abs(fontProbe.letterSpacing) > 0.5) {
      fontErrors.push(`xterm glyph spacing is ${fontProbe.letterSpacing}px; expected at most 0.5px`);
    }
    if (TEST_CASE === "font") {
      console.log(JSON.stringify({ fontProbe }, null, 2));
      if (fontErrors.length) {
        console.error(fontErrors.map(error => `FAIL: ${error}`).join("\n"));
        process.exitCode = 1;
      } else {
        console.log("PASS: xterm loads its bundled Nerd Font fallback");
      }
      return;
    }
    const inlineReport = resizeReports.at(-1);
    const reportCountBeforeFullscreen = resizeReports.length;

    await page.evaluate(id => window.openTerminal(id), TASK_ID);
    await page.waitForSelector("#termModal:not(.hidden) #termX .xterm-screen");
    await page.waitForTimeout(500);
    const during = await page.evaluate(terminalBoxSnapshot);
    const fullscreenReport = resizeReports.at(-1);

    // Use the same cancellation path as a user leaving fullscreen with Escape.
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("termModal")?.classList.contains("hidden"));
    await page.waitForTimeout(500);
    const after = await page.evaluate(terminalBoxSnapshot);
    const restoredReport = resizeReports.at(-1);

    const errors = [];
    const approximately = (a, b, tolerance = 1) => Math.abs(a - b) <= tolerance;
    const fits = box => box &&
      box.screen.width <= box.host.width + 2 &&
      box.screen.height <= box.host.height + 2 &&
      box.screen.width >= box.host.width * 0.8 &&
      box.screen.height >= box.host.height * 0.8;

    if (!inlineReport?.cols || !inlineReport?.rows) errors.push("inline terminal did not report a fitted geometry");
    if (!inputReports.map(report => report.keys || "").join("").includes("typed")) {
      errors.push(`xterm input was not sent as raw keystrokes: ${JSON.stringify(inputReports)}`);
    }
    if (!streamProbe.lines.some(line => line.includes("OMP terminal probe> typed"))) {
      errors.push(`live terminal chunks were not rendered in-place: ${JSON.stringify(streamProbe)}`);
    }
    errors.push(...fontErrors);
    if (resizeReports.length <= reportCountBeforeFullscreen) errors.push("fullscreen terminal did not report a new geometry");
    if (!fits(before.inline)) errors.push(`inline terminal does not fit its host: ${JSON.stringify(before.inline)}`);
    if (!fits(during.fullscreen)) errors.push(`fullscreen terminal does not fit its host: ${JSON.stringify(during.fullscreen)}`);
    if (!inlineReport || !restoredReport || restoredReport.cols !== inlineReport.cols || restoredReport.rows !== inlineReport.rows) {
      errors.push(`closing fullscreen left tmux at ${JSON.stringify(restoredReport)} instead of inline ${JSON.stringify(inlineReport)}`);
    }
    if (!before.detail || !after.detail ||
        !approximately(before.detail.x, after.detail.x) ||
        !approximately(before.detail.width, after.detail.width) ||
        !approximately(before.detail.height, after.detail.height)) {
      errors.push(`detail layout changed after fullscreen: before=${JSON.stringify(before.detail)} after=${JSON.stringify(after.detail)}`);
    }
    if (pageErrors.length) errors.push(`page errors: ${pageErrors.join(" | ")}`);

    console.log(JSON.stringify({ fontProbe, streamProbe, inputReports, inlineReport, fullscreenReport, restoredReport, before, during, after }, null, 2));
    if (errors.length) {
      console.error(errors.map(error => `FAIL: ${error}`).join("\n"));
      process.exitCode = 1;
    } else {
      console.log("PASS: interactive terminal geometry survives fullscreen round-trip");
    }
  } finally {
    await browser.close();
  }
})();
