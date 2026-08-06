// 模块 settings（由 scripts/split-frontend.py 生成）
import { api, toast } from "./core.js";
import { loadAll } from "./main.js";

export async function loadSettings() {
  try {
    const s = await api("/api/settings");
    const el = document.getElementById("retentionDays");
    if (el) el.value = s.retention_days || "";
    const wt = document.getElementById("wtRetentionDays");
    if (wt) wt.value = s.worktree_retention_days || "";
  } catch (_) {}
}

export async function saveWtRetention() {
  try {
    const days = document.getElementById("wtRetentionDays").value.trim();
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ worktree_retention_days: days }) });
    toast("已保存，每小时自动清理一次");
  } catch (e) { toast(e.message, true); }
}

export async function saveRetention() {
  try {
    const days = document.getElementById("retentionDays").value.trim();
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ retention_days: days }) });
    toast("已保存，每小时执行一次自动清理");
  } catch (e) { toast(e.message, true); }
}

export async function runCleanup() {
  const agentId = Number(document.getElementById("cleanupAgent").value) || null;
  const days = Number(document.getElementById("cleanupDays").value);
  const before = days > 0 ? new Date(Date.now() - days * 86400000).toISOString() : "";
  if (!confirm(`删除${agentId ? "该角色" : "全部角色"}${before ? "、" + days + " 天前" : ""}的终态任务？不可恢复！`)) return;
  try {
    const r = await api("/api/tasks/cleanup", { method: "POST", body: JSON.stringify({ agent_id: agentId, before }) });
    toast(`已删除 ${r.deleted} 条历史`);
    await loadAll();
  } catch (e) { toast(e.message, true); }
}

/* ============================================================
   Dashboard（默认首页）：统计条 + 任务执行区 + 项目区 + Agent 区
   ============================================================ */
