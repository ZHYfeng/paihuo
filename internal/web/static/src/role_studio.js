// 角色编辑器：创建助手对话、配置与被创建 Agent 测试保持在同一屏。
import { api, closeModal, esc, openModal, state, toast } from "./core.js";
import { loadAll, loadSchema } from "./main.js";
import { readConfigFrom, renderAgentList, schemaFormHTML, showAgentDetail } from "./agents.js";
import { loadSkillLib } from "./skills.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function firstEnabledAgent(excludeID = 0) {
  return state.agents.find(a => a.enabled && a.id !== excludeID) || state.agents.find(a => a.enabled) || state.agents[0] || null;
}

function blankDraft() {
  const cli = Object.keys(state.schema || {})[0] || state.agents[0]?.cli || "";
  return { name: "", description: "", cli, max_concurrency: 1, role_config: {} };
}

function draftFromAgent(agent) {
  return {
    name: agent?.name || "",
    description: agent?.description || "",
    cli: agent?.cli || Object.keys(state.schema || {})[0] || "",
    max_concurrency: agent?.max_concurrency || 1,
    role_config: clone(agent?.role_config || {}),
  };
}

function studioState() {
  return state.roleStudio;
}

function currentDraftFromForm() {
  const s = studioState();
  if (!s) return null;
  const draft = clone(s.draft);
  draft.name = String(document.getElementById("rsName")?.value || "").trim();
  draft.description = String(document.getElementById("rsDescription")?.value || "").trim();
  draft.cli = String(document.getElementById("rsCli")?.value || draft.cli || "");
  draft.max_concurrency = Number(document.getElementById("rsMaxConcurrency")?.value || 1);
  const schema = state.schema[draft.cli];
  const form = document.getElementById("rsSchema");
  draft.role_config = schema && form ? readConfigFrom(schema, form) : clone(draft.role_config || {});
  if (!Number.isInteger(draft.max_concurrency) || draft.max_concurrency < 1) draft.max_concurrency = 1;
  return draft;
}

function draftSummary(draft) {
  const cfg = draft?.role_config || {};
  const skills = Array.isArray(cfg.skills) ? cfg.skills.length : 0;
  return `${draft?.name || "未命名角色"} · ${draft?.cli || "未选择 CLI"} · ${skills} 个 Skills`;
}

function roleStudioMessageHTML(message) {
  const role = message.role === "user" ? "user" : "assistant";
  return `<article class="rs-message ${role}">
    <div class="rs-message-label">${role === "user" ? "你" : "创建助手"}</div>
    <div class="rs-message-body">${esc(message.content || "").replace(/\n/g, "<br>")}</div>
  </article>`;
}

function testMessageHTML(message) {
  const role = message.role === "user" ? "user" : "assistant";
  return `<article class="rs-message ${role}">
    <div class="rs-message-label">${role === "user" ? "测试输入" : "被创建 Agent"}</div>
    <div class="rs-message-body">${esc(message.content || "").replace(/\n/g, "<br>")}</div>
  </article>`;
}

function renderStudioMessages() {
  const s = studioState();
  if (!s) return;
  const creator = document.getElementById("rsCreatorChat");
  const test = document.getElementById("rsTestChat");
  if (creator) {
    creator.innerHTML = s.creatorMessages.length
      ? s.creatorMessages.map(roleStudioMessageHTML).join("")
      : `<div class="rs-chat-empty"><span class="rs-empty-mark">✦</span><b>描述你想创建的角色</b><span>创建助手会分析目标、推荐 Skills，并把可测试的配置放到中间。</span></div>`;
    creator.scrollTop = creator.scrollHeight;
  }
  if (test) {
    test.innerHTML = s.testMessages.length
      ? s.testMessages.map(testMessageHTML).join("")
      : `<div class="rs-chat-empty"><span class="rs-empty-mark">◌</span><b>先给角色一个小任务</b><span>测试结果会保留在这里，创建助手可以读取并继续调整草稿。</span></div>`;
    test.scrollTop = test.scrollHeight;
  }
}

function renderCreatorSelect() {
  const s = studioState();
  const select = document.getElementById("rsCreatorAgent");
  if (!s || !select) return;
  const candidates = state.agents.filter(a => a.enabled || a.id === s.creatorAgentID);
  select.innerHTML = candidates.length
    ? candidates.map(a => `<option value="${a.id}" ${a.id === s.creatorAgentID ? "selected" : ""}>${esc(a.name)} · ${esc(a.cli)}</option>`).join("")
    : `<option value="">暂无可用角色</option>`;
  select.disabled = !candidates.length;
  select.onchange = () => { s.creatorAgentID = Number(select.value) || 0; };
}

function renderStudioDiff() {
  const s = studioState();
  const box = document.getElementById("rsDiffBody");
  if (!s || !box) return;
  const now = JSON.stringify(s.draft);
  const base = JSON.stringify(s.baseDraft);
  if (now === base) {
    box.innerHTML = `<span class="rs-diff-empty">尚未修改</span>`;
    return;
  }
  const rows = [];
  const fields = [
    ["name", "名称"], ["description", "描述"], ["cli", "CLI"], ["max_concurrency", "最大并发"],
  ];
  fields.forEach(([key, label]) => {
    const before = s.baseDraft?.[key] ?? "";
    const after = s.draft?.[key] ?? "";
    if (String(before) !== String(after)) rows.push(`<div><b>${label}</b><span class="old">${esc(String(before || "未设置"))}</span><span class="arrow">→</span><span class="new">${esc(String(after || "未设置"))}</span></div>`);
  });
  const oldCfg = s.baseDraft?.role_config || {};
  const newCfg = s.draft?.role_config || {};
  ["model", "system_prompt", "instructions", "thinking", "skills"].forEach(key => {
    if (JSON.stringify(oldCfg[key] ?? "") !== JSON.stringify(newCfg[key] ?? "")) {
      const oldValue = Array.isArray(oldCfg[key]) ? `${oldCfg[key].length} 项` : String(oldCfg[key] || "未设置");
      const newValue = Array.isArray(newCfg[key]) ? `${newCfg[key].length} 项` : String(newCfg[key] || "未设置");
      rows.push(`<div><b>${esc(key)}</b><span class="old">${esc(oldValue)}</span><span class="arrow">→</span><span class="new">${esc(newValue)}</span></div>`);
    }
  });
  box.innerHTML = rows.length ? rows.join("") : `<span class="rs-diff-empty">配置有变化</span>`;
}

function renderStudioDraft() {
  const s = studioState();
  if (!s) return;
  const d = s.draft;
  const title = document.getElementById("roleStudioTitle");
  if (title) title.textContent = d.name ? `编辑：${d.name}` : "创建角色";
  const status = document.getElementById("roleStudioStatus");
  if (status) status.textContent = s.agentID ? "编辑草稿 · 未发布" : "新角色草稿 · 未保存";
  const name = document.getElementById("rsName");
  const desc = document.getElementById("rsDescription");
  const conc = document.getElementById("rsMaxConcurrency");
  if (name) name.value = d.name || "";
  if (desc) desc.value = d.description || "";
  if (conc) conc.value = d.max_concurrency || 1;
  const cli = document.getElementById("rsCli");
  if (cli) {
    cli.innerHTML = Object.values(state.schema || {}).map(schema => `<option value="${esc(schema.id)}">${esc(schema.name)}</option>`).join("");
    cli.value = d.cli;
  }
  const schema = state.schema[d.cli];
  const schemaBox = document.getElementById("rsSchema");
  if (schemaBox) schemaBox.innerHTML = schema ? schemaFormHTML(schema, d.role_config || {}) : `<div class="empty">CLI schema 未加载</div>`;
  const badge = document.getElementById("rsDraftBadge");
  if (badge) badge.textContent = JSON.stringify(s.baseDraft) === JSON.stringify(d) ? "未修改" : "有未保存修改";
  const skillCount = Array.isArray(d.role_config?.skills) ? d.role_config.skills.length : 0;
  const note = document.getElementById("rsSkillNote");
  if (note) note.textContent = skillCount ? `运行时会启用 ${skillCount} 个角色 Skills` : "尚未选择角色 Skills";
  const meta = document.getElementById("rsTestMeta");
  if (meta) meta.innerHTML = `<span class="avatar sm av-${esc(d.cli)}">${esc((d.name || "?").slice(0, 1))}</span><span><b>${esc(d.name || "未命名角色")}</b><small>${esc(d.cli || "未选择 CLI")} · 使用当前草稿测试</small></span>`;
  renderStudioDiff();
  renderStudioMessages();
}

export async function openRoleStudio(id) {
  const agent = id ? state.agents.find(a => a.id === id) : null;
  if (id && !agent) return toast("角色不存在", true);
  await loadSchema();
  await loadSkillLib();
  const existing = state.roleStudio;
  if (!existing || existing.agentID !== (agent?.id || 0)) {
    const draft = agent ? draftFromAgent(agent) : blankDraft();
    const creator = firstEnabledAgent(agent?.id || 0);
    state.roleStudio = {
      agentID: agent?.id || 0,
      agentEnabled: agent?.enabled ?? true,
      creatorAgentID: creator?.id || 0,
      draft,
      baseDraft: clone(draft),
      creatorMessages: [],
      testMessages: [],
      busy: false,
      testBusy: false,
    };
  }
  renderCreatorSelect();
  renderStudioDraft();
  openModal("roleStudioModal");
}

export function openCurrentRoleEditor() {
  const id = studioState()?.agentID || state.agentEditing?.id;
  if (id) openRoleStudio(id);
}

export function changeRoleStudioCli() {
  const s = studioState();
  if (!s) return;
  const current = currentDraftFromForm();
  const nextCLI = String(document.getElementById("rsCli")?.value || "");
  const oldCfg = current.role_config || {};
  current.cli = nextCLI;
  current.role_config = {
    model: oldCfg.model || "",
    system_prompt: oldCfg.system_prompt || "",
    instructions: oldCfg.instructions || "",
    skills: Array.isArray(oldCfg.skills) ? oldCfg.skills : [],
    thinking: oldCfg.thinking || "",
    plugins: Array.isArray(oldCfg.plugins) ? oldCfg.plugins : [],
    extra_args: Array.isArray(oldCfg.extra_args) ? oldCfg.extra_args : [],
    env: oldCfg.env || {},
    custom: {},
  };
  s.draft = current;
  renderStudioDraft();
}

export function roleStudioQuickAsk(message) {
  const input = document.getElementById("rsCreatorInput");
  if (!input) return;
  input.value = message;
  sendRoleStudioChat();
}

export async function sendRoleStudioChat(event) {
  event?.preventDefault?.();
  const s = studioState();
  const input = document.getElementById("rsCreatorInput");
  const message = String(input?.value || "").trim();
  if (!s || !message || s.busy) return;
  s.draft = currentDraftFromForm();
  const creator = state.agents.find(a => a.id === s.creatorAgentID);
  if (!creator) return toast("请先创建并启用一个角色作为创建助手", true);
  s.creatorMessages.push({ role: "user", content: message });
  if (input) input.value = "";
  s.busy = true;
  setStudioBusy("rsCreatorState", true, "分析中…");
  renderStudioMessages();
  try {
    const result = await api("/api/role-studio/chat", {
      method: "POST",
      body: JSON.stringify({
        creator_agent_id: s.creatorAgentID,
        draft: s.draft,
        message,
        creator_messages: s.creatorMessages.slice(0, -1),
        test_messages: s.testMessages,
      }),
    });
    if (result?.draft) {
      s.draft = result.draft;
      renderStudioDraft();
    }
    s.creatorMessages.push({ role: "assistant", content: result?.message || "创建助手没有返回说明。" });
  } catch (e) {
    s.creatorMessages.push({ role: "assistant", content: `调用创建助手失败：${e.message}` });
  } finally {
    s.busy = false;
    setStudioBusy("rsCreatorState", false, "待命");
    renderStudioMessages();
  }
}

export async function sendRoleStudioTest(event) {
  event?.preventDefault?.();
  const s = studioState();
  const input = document.getElementById("rsTestInput");
  const message = String(input?.value || "").trim();
  if (!s || !message || s.testBusy) return;
  s.draft = currentDraftFromForm();
  if (!s.draft.cli) return toast("请先选择被创建 Agent 的 CLI", true);
  s.testMessages.push({ role: "user", content: message });
  if (input) input.value = "";
  s.testBusy = true;
  setStudioBusy("rsTestState", true, "执行中…");
  renderStudioDraft();
  try {
    const result = await api("/api/role-studio/test", {
      method: "POST",
      body: JSON.stringify({ draft: s.draft, message, test_messages: s.testMessages.slice(0, -1) }),
    });
    s.testMessages.push({ role: "assistant", content: result?.output || "被创建 Agent 没有返回内容。" });
  } catch (e) {
    s.testMessages.push({ role: "assistant", content: `测试执行失败：${e.message}` });
  } finally {
    s.testBusy = false;
    setStudioBusy("rsTestState", false, "测试模式");
    renderStudioMessages();
  }
}

function setStudioBusy(id, busy, text) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = text;
    el.classList.toggle("running", busy);
  }
  ["rsCreatorInput", "rsTestInput"].forEach(inputID => {
    const input = document.getElementById(inputID);
    if (input && ((inputID === "rsCreatorInput" && id === "rsCreatorState") || (inputID === "rsTestInput" && id === "rsTestState"))) input.disabled = busy;
  });
}

export async function saveRoleStudio() {
  const s = studioState();
  if (!s) return;
  const draft = currentDraftFromForm();
  if (!draft.name) return toast("角色名称不能为空", true);
  if (!draft.cli) return toast("请选择角色 CLI", true);
  const body = {
    name: draft.name,
    description: draft.description,
    cli: draft.cli,
    max_concurrency: draft.max_concurrency,
    enabled: s.agentEnabled,
    role_config: draft.role_config,
  };
  const save = document.querySelector("#roleStudioModal .role-studio-head-actions .primary");
  if (save) { save.disabled = true; save.textContent = "保存中…"; }
  try {
    const result = s.agentID
      ? await api(`/api/agents/${s.agentID}`, { method: "PATCH", body: JSON.stringify(body) })
      : await api("/api/agents", { method: "POST", body: JSON.stringify(body) });
    closeModal("roleStudioModal");
    state.roleStudio = null;
    await loadAll();
    const detailVisible = !document.getElementById("agentDetailShell")?.classList.contains("hidden");
    if (s.agentID && detailVisible) showAgentDetail(s.agentID);
    else renderAgentList();
    toast(s.agentID ? "角色草稿已保存" : `角色已创建：${result?.name || draft.name}`);
  } catch (e) {
    toast(`保存角色失败：${e.message}`, true);
  } finally {
    if (save) { save.disabled = false; save.textContent = "保存角色"; }
  }
}
