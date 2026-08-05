// 模块 provision（由 scripts/split-frontend.py 生成）
import { api, closeModal, esc, openModal, toast } from "./core.js";

export let provState = { prov: [], instCli: null };

export async function loadProvision() {
  try { provState.prov = await api("/api/provision"); } catch (_) { provState.prov = []; }
  renderProvGrid();
}

export function renderProvGrid() {
  const grid = document.getElementById("provGrid");
  if (!grid) return;
  const empty = document.getElementById("provEmpty");
  if (empty) empty.classList.add("hidden");
  grid.innerHTML = provState.prov.map(p => `
    <div class="prov-card ${p.installed ? "" : "not-installed"}">
      <div class="pc-top">
        <span class="avatar lg av-${esc(p.id)}">${esc((p.name || "?").slice(0, 1))}</span>
        <div class="ac-id">
          <div class="ac-name">${esc(p.name)}</div>
          <div class="ac-sub">
            ${p.installed ? `<span class="badge succeeded">已安装</span>` : `<span class="badge cancelled">未安装</span>`}
            ${p.installed ? `<span class="badge ${p.login ? "succeeded" : "awaiting_review"}">${p.login ? "已登录" : "未登录"}</span>` : ""}
          </div>
        </div>
        ${p.installed ? `<span class="prov-ver">${esc(p.version)}</span>` : ""}
      </div>
      <div class="prov-body">
        ${!p.installed ? `<div class="prov-cmd" title="官方安装命令">$ ${esc(p.install_cmd || "（请参考官方文档）")}</div>`
          : p.login ? `<div class="prov-login-ok">已检测到登录凭据 ✓</div>`
          : `<div class="prov-login-hint">${esc(p.login_hint || "请在服务器终端完成登录")}</div>`}
      </div>
      <div class="ac-stats prov-actions">
        ${!p.installed
          ? `<button class="btn sm brand" onclick="installProvision('${p.id}')">安装</button>`
          : `<button class="btn sm" onclick="installProvision('${p.id}')">重装/更新</button>`}
        <a class="btn sm ghost" href="${esc(p.docs)}" target="_blank" rel="noreferrer">官方文档 ↗</a>
        ${p.installed ? `<button class="btn sm" onclick="copyText('${esc(p.login_hint || "")}')">复制登录指引</button>` : ""}
        ${p.installed ? `<button class="btn sm" onclick="createDefaultRole('${p.id}')">创建默认角色</button>` : ""}
      </div>
    </div>`).join("");
  const cnt = document.getElementById("provCount");
  if (cnt) cnt.textContent = `已安装 ${provState.prov.filter(p => p.installed).length}/${provState.prov.length}`;
}

export async function installProvision(cli) {
  provState.instCli = cli;
  const box = document.getElementById("instBox");
  const title = document.getElementById("instTitle");
  box.innerHTML = `<div class="empty">正在启动安装...</div>`;
  title.textContent = `安装 ${cli}`;
  openModal("instModal");
  try {
    const r = await api("/api/provision/install", { method: "POST", body: JSON.stringify({ cli }) });
    // 命令回显与执行输出由服务端经 SSE provision 事件推送，这里不再重复追加
    setTimeout(loadProvision, 3000);
  } catch (e) {
    box.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    provState.instCli = null;
  }
}

export function appendInstLine(line) {
  const box = document.getElementById("instBox");
  if (!box) return;
  const c = line.startsWith("$") ? "sys" : "out";
  box.insertAdjacentHTML("beforeend", `<div class="line"><span class="c ${c}">${esc(line)}</span></div>`);
  box.scrollTop = box.scrollHeight;
}

export function closeInstTerminal() { provState.instCli = null; closeModal("instModal"); }

export function refreshProvision() { loadProvision(); }

export function copyText(t) {
  navigator.clipboard.writeText(t).then(() => toast("已复制")).catch(() => toast("复制失败", true));
}

export async function createDefaultRole(cli) {
  const name = prompt(`创建基于 ${cli} 的默认角色名称`, cli);
  if (!name) return;
  try {
    await api("/api/agents", { method: "POST", body: JSON.stringify({ name, cli, enabled: true }) });
    toast("已创建角色，可在角色页继续定制");
  } catch (e) { toast(e.message, true); }
}

/* ============================================================
   hash 路由 + SSE
   ============================================================ */

/* ---- 侧边栏折叠（localStorage 记忆） ---- */