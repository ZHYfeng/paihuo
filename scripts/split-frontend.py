#!/usr/bin/env python3
"""一次性前端模块化工具：把 app.js 拆成 src/ 下的 ES 模块（可重入，重新生成）。
生成后需运行 scripts/build-frontend.sh 打包出 app.bundle.js。"""
import re, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "internal/web/static/app.js")
OUT = os.path.join(ROOT, "internal/web/static/src")
TPL = os.path.join(ROOT, "internal/web/templates")
os.makedirs(OUT, exist_ok=True)

MODULES = {
    "core": ["state", "STATUS_LABEL", "PERM_LABEL", "ST_COLOR", "BOARD_COLS", "BUILTIN_KEYS",
             "esc", "ICONS", "icon", "fmtPct", "fmtNum", "fmtDur", "toast", "api",
             "openModal", "closeModal", "logout"],
    "task": ["currentFilters", "filteredTasks", "renderBoard", "cardHTML", "renderList",
             "setView", "applyFilters", "openTask", "closeDetail", "showDetail", "hideDetail",
             "refreshDetail", "renderDetail", "loadWorkspace", "wsMerge", "wsDiscard",
             "gitInitProject", "renderSide", "patchTask", "setTaskStatus", "rejectTask",
             "deleteTask", "loadChildren", "openSubTask", "resumeTask", "loadDiff", "tsOf",
             "logLineHTML", "logsHTML", "appendLog", "copyLogs", "openNewTask", "submitTask",
             "applyTemplate", "saveAsTemplate"],
    "terminal": ["term", "initTerm", "termWrite", "openTerminal", "closeTerminal"],
    "history": ["loadHistory", "renderHistory", "toggleRow", "toggleAll", "deleteSelected",
                "cleanupHistory"],
    "projects": ["renderProjectList", "openProject", "closeProjectDetail", "showProjectDetail",
                 "hideProjectDetail", "refreshProjectDetail", "renderProjectDetail",
                 "openProjectModal", "submitProject", "patchProject", "deleteProject",
                 "dailyChartHTML", "ringHTML", "statusBarHTML", "dirState", "dirLoad",
                 "openDirPicker", "pickDir", "mkdirCurrent", "loadProjDatalist"],
    "agents": ["setAgentView", "agentTaskStats", "renderAgentGrid", "renderAgentTable",
               "renderAgentList", "toggleAgent", "agentTabFromCard", "openAgentDetail",
               "closeAgentDetail", "showAgentDetail", "hideAgentDetail", "agentTab",
               "loadAgentStats", "renderAgentOverview", "renderAgentStats", "fieldValue",
               "chipHTML", "chipEditorValue", "syncChips", "addChip", "removeChip",
               "toggleSkill", "skillsControlHTML", "chipsControlHTML", "fieldControlHTML",
               "schemaFormHTML", "readConfigFrom", "renderAgentConfig", "saveAgentConfig",
               "renderAgentEnv", "saveAgentEnv", "openAgentModal", "renderAgentModalSchema",
               "submitAgent", "deleteAgent", "parseEnv", "pendingAgentTab", "dlSeq"],
    "schedules": ["renderScheduleList", "toggleSchedule", "openScheduleModal",
                  "submitSchedule", "deleteSchedule"],
    "skills": ["setSkillTab", "loadExtensions", "openExtModal", "submitExt", "removeExt",
               "loadSkillLib", "renderSkillLib", "openSkillModal", "submitSkill",
               "deleteSkill", "loadTemplates", "renderTemplateList", "deleteTemplate"],
    "settings": ["loadSettings", "saveWtRetention", "saveRetention", "runCleanup"],
    "dashboard": ["dashCardHTML", "loadDashboard", "renderDashTasks", "renderDashProjects",
                  "loadDashAgents"],
    "provision": ["provState", "loadProvision", "renderProvGrid", "installProvision",
                  "appendInstLine", "closeInstTerminal", "refreshProvision", "copyText",
                  "createDefaultRole"],
    "main": ["loadAll", "loadSchema", "fillSelects", "refreshOverview", "renderStatsStrip",
             "toggleSidebar", "restoreSidebar", "initShortcuts", "route",
             "refreshOverviewSoon", "sse", "ovTimer"],
}
NAME2MOD = {n: m for m, names in MODULES.items() for n in names}

lines = open(SRC, encoding="utf-8").read().split("\n")

# 顶层声明起点
starts = []
for i, line in enumerate(lines):
    m = re.match(r"^(async )?function (\w+)\(", line)
    if m:
        starts.append((i, m.group(2)))
        continue
    m = re.match(r"^(const|let|var) (\w+) =", line)
    if m:
        starts.append((i, m.group(2)))

assert len(starts) == len(NAME2MOD), f"声明数 {len(starts)} != 分配数 {len(NAME2MOD)}"
missing = [n for _, n in starts if n not in NAME2MOD]
if missing:
    raise SystemExit(f"未分配: {missing}")
unused = [n for n in NAME2MOD if n not in {n for _, n in starts}]
if unused:
    raise SystemExit(f"分配了但不存在: {unused}")

blocks = []
for idx, (i, name) in enumerate(starts):
    end = starts[idx + 1][0] if idx + 1 < len(starts) else len(lines)
    blocks.append((name, i, end))

HEADER = "".join(lines[:starts[0][0]])
mods = {m: [] for m in MODULES}
for name, i, end in blocks:
    mods[NAME2MOD[name]].append((name, i, end))

# 尾部注册段（pagehide + DOMContentLoaded 及其之前的所有代码）归 main
# 找 pagehide 注册行
tail_start = next(i for i, l in enumerate(lines) if l.startswith("window.addEventListener(\"pagehide\""))

IGNORE = set("""window document console alert prompt confirm setTimeout setInterval
clearTimeout clearInterval fetch EventSource location localStorage sessionStorage history
navigator XMLHttpRequest FormData URL URLSearchParams TextEncoder TextDecoder Date Math JSON
Object Array String Number Boolean RegExp Promise Map Set WeakMap WeakSet Symbol BigInt
parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent encodeURI decodeURI
crypto performance requestAnimationFrame cancelAnimationFrame IntersectionObserver
ResizeObserver MutationObserver CustomEvent Event KeyboardEvent MouseEvent HTMLElement
HTMLInputElement HTMLSelectElement HTMLTextAreaElement HTMLElement Node Element Error
TypeError SyntaxError RangeError ReferenceError AbortController Blob FileReader DOMParser
undefined Infinity NaN Terminal FitAddon globalThis self top parent opener name status
closed frames length origin screen innerWidth innerHeight scrollX scrollY devicePixelRatio
escape unescape atob btoa structuredClone queueMicrotask Intl Reflect Proxy WeakRef
FinalizationRegistry isFinite isNaN Float32Array Float64Array Int8Array Uint8Array
Int16Array Uint16Array Int32Array Uint32Array BigInt64Array BigUint64Array Uint8ClampedArray
PromiseRejectionEvent DOMException URLPattern CustomElementRegistry ShadowRoot DocumentFragment
Text Comment CDATASection ProcessingInstruction Attr DOMTokenList ClassList NodeList
HTMLCollection File FileList DataTransfer DragEvent ClipboardEvent WheelEvent FocusEvent
InputEvent CompositionEvent beforeunload unload pagehide pageshow visibilitychange
keydown keyup keypress mousedown mouseup click dblclick change input submit focus blur
scroll resize touchstart touchend touchmove contextmenu error load DOMContentLoaded
resolvedData Image FontFace Notification requestIdleCallback cancelIdleCallback
getComputedStyle matchMedia open close stop preventDefault stopPropagation addEventListener
removeEventListener querySelector querySelectorAll getElementById getElementsByClassName
getElementsByTagName createElement createTextNode appendChild removeChild insertBefore
replaceChild cloneNode setAttribute getAttribute removeAttribute classList dataset style
innerHTML textContent value checked disabled onclick onchange oninput onkeydown onkeyup
onmousedown onmouseup onfocus onblur onsubmit onload onerror onclick onwheel onscroll
oncontextmenu onpaste oncopy oncut onselect onreset onmouseenter onmouseleave""".split())

IDENT = re.compile(r"\b[a-zA-Z_$][a-zA-Z0-9_$]*\b")

def scan_idents(text):
    return set(IDENT.findall(text))

# 模板全局函数清单（先算，供 main 的 import 分析使用）
globals_needed = set()
for f in os.listdir(TPL):
    if not f.endswith(".html"):
        continue
    t = open(os.path.join(TPL, f), encoding="utf-8").read()
    for m in re.finditer(r'on[a-z]+\s*=\s*"([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(', t):
        g = m.group(1)
        if g in NAME2MOD:
            globals_needed.add(g)
    for m in re.finditer(r'window\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(', t):
        g = m.group(1)
        if g in NAME2MOD:
            globals_needed.add(g)

def gen_module(mname):
    names = MODULES[mname]
    own = set(names)
    body = []
    for name, i, end in blocks:
        if name in own:
            body.append("export " + lines[i])
            body.append("\n".join(lines[i + 1:end]))
    text = "\n".join(body)
    # 去注释，避免 import 注释里的标识符（保守起见：同时扫描原文，靠 ignore 集过滤）
    used = scan_idents(text) | scan_idents("\n".join(l for l in lines if False))
    if mname == "main":
        used |= {g for g in globals_needed if g not in own}
    deps = {}
    for sym in used:
        if sym in own or sym in IGNORE or sym not in NAME2MOD:
            continue
        dm = NAME2MOD[sym]
        if dm == mname:
            continue
        deps.setdefault(dm, []).append(sym)
    imports = []
    for dm in sorted(deps):
        syms = ", ".join(sorted(deps[dm]))
        imports.append(f'import {{ {syms} }} from "./{dm}.js";')
    return imports, body

for mname in MODULES:
    imports, body = gen_module(mname)
    out = [f"// 模块 {mname}（由 scripts/split-frontend.py 生成）"]
    out += imports
    out.append("")
    out += body
    open(os.path.join(OUT, mname + ".js"), "w", encoding="utf-8").write("\n".join(out))

# main.js 追加尾部注册段 + window 全局导出（此段在 import 分析之后生成，需补符号）
tail = "\n".join(lines[tail_start:])

exports = []
for g in sorted(globals_needed):
    exports.append(f"window.{g} = {g};")
open(os.path.join(OUT, "main.js"), "a", encoding="utf-8").write(
    "\n\n// ===== 模板 onclick 等引用的全局函数（脚本自动生成，勿手改） =====\n"
    + "\n".join(exports)
    + "\n\n// ===== 页面生命周期 =====\n" + tail)

print(f"OK：{len(starts)} 个声明 → {len(MODULES)} 个模块，全局导出 {len(exports)} 个")
print("模板引用:", ", ".join(sorted(globals_needed)))
