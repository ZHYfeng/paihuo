// Regression for copying a role and then switching its CLI.
// Run against a local PaiHuo server with:
//   E2E_URL=http://127.0.0.1:18099 E2E_TOKEN=t node scripts/role-studio-copy.e2e.js
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

const portableFields = [
  { key: "system_prompt", label: "系统提示词", type: "textarea", builtin: true, group: "指令" },
  { key: "instructions", label: "附加指令", type: "textarea", builtin: true, group: "指令" },
  { key: "skills", label: "Skills", type: "list", source: "skills", builtin: true, group: "能力" },
];
const schema = [
  {
    id: "codex", name: "Codex", docs: "", fields: [
      { key: "model", label: "模型", type: "text", builtin: true, suggestions: ["gpt-5.6-luna"], group: "模型" },
      { key: "thinking", label: "思考强度", type: "select", builtin: true, options: ["", "max"], group: "模型" },
      ...portableFields,
    ],
  },
  {
    id: "opencode", name: "OpenCode", docs: "", fields: [
      { key: "model", label: "模型", type: "text", builtin: true, suggestions: ["opencode-go/deepseek-v4-flash"], group: "模型" },
      { key: "thinking", label: "思考强度", type: "select", builtin: true, options: ["", "max"], group: "模型" },
      ...portableFields,
    ],
  },
];
const sourceAgent = {
  id: 1,
  name: "Frontend",
  description: "source role",
  cli: "codex",
  enabled: true,
  max_concurrency: 2,
  role_config: {
    model: "gpt-5.6-luna",
    thinking: "max",
    system_prompt: "keep system prompt",
    instructions: "keep instructions",
    skills: ["/skills/design"],
  },
};

function json(route, value, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
}

(async () => {
  const browser = await chromium.launch({ executablePath: findChrome() });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(5000);

  await page.route("**/api/**", route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/agents") return json(route, [sourceAgent]);
    if (pathname === "/api/agents/schema") return json(route, schema);
    if (pathname === "/api/skills") {
      return json(route, [{ name: "design", dir: "/skills/design", description: "design skill", tags: [] }]);
    }
    if (["/api/tasks", "/api/projects", "/api/schedules", "/api/templates"].includes(pathname)) return json(route, []);
    if (pathname === "/api/stats/overview") {
      return json(route, { status_counts: [], daily: [], in_flight: 0, success_rate: 0, avg_duration: 0, projects: 0 });
    }
    return json(route, {});
  });

  try {
    await page.goto(`${BASE_URL}/login`);
    await page.fill("input[type=password]", TOKEN);
    await page.click("button[type=submit]");
    await page.waitForURL(url => !url.pathname.includes("login"));
    await page.goto(`${BASE_URL}/roles`);
    await page.waitForFunction(() => typeof window.copyRole === "function");
    await page.evaluate(() => window.copyRole(1));
    await page.waitForSelector("#roleStudioModal:not(.hidden) #rsCli");

    const copiedModel = await page.locator('#rsSchema [data-key="model"]').inputValue();
    await page.selectOption("#rsCli", "opencode");
    const probe = await page.evaluate(() => {
      const read = key => document.querySelector(`#rsSchema [data-key="${key}"]`)?.value || "";
      const modelInput = document.querySelector('#rsSchema [data-key="model"]');
      return {
        cli: document.getElementById("rsCli")?.value || "",
        model: read("model"),
        thinking: read("thinking"),
        systemPrompt: read("system_prompt"),
        instructions: read("instructions"),
        skills: read("skills"),
        suggestions: modelInput?.list ? [...modelInput.list.options].map(option => option.value) : [],
      };
    });

    const errors = [];
    if (copiedModel !== sourceAgent.role_config.model) {
      errors.push(`copy did not start from the source model: ${JSON.stringify(copiedModel)}`);
    }
    if (probe.model) errors.push(`switching CLI retained source model ${JSON.stringify(probe.model)}`);
    if (probe.thinking) errors.push(`switching CLI retained source thinking ${JSON.stringify(probe.thinking)}`);
    if (probe.systemPrompt !== sourceAgent.role_config.system_prompt) errors.push("portable system prompt was lost");
    if (probe.instructions !== sourceAgent.role_config.instructions) errors.push("portable instructions were lost");
    if (probe.skills !== sourceAgent.role_config.skills.join(",")) errors.push("portable skills were lost");

    console.log(JSON.stringify({ copiedModel, probe }, null, 2));
    if (errors.length) {
      console.error(errors.map(error => `FAIL: ${error}`).join("\n"));
      process.exitCode = 1;
    } else {
      console.log("PASS: changing a copied role's CLI resets incompatible model settings");
    }
  } finally {
    await browser.close();
  }
})();
