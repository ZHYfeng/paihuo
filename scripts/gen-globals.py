#!/usr/bin/env python3
"""扫描模板静态 onclick 与 src 模块 JS 字符串内生成的 onclick 引用，
在 main.js 的标记区间内生成/更新 window 全局导出，并校验无遗漏。
由 scripts/build-frontend.sh 在 esbuild 打包前调用。"""
import os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TPL = os.path.join(ROOT, "internal/web/templates")
SRC = os.path.join(ROOT, "internal/web/static/src")
MAIN = os.path.join(SRC, "main.js")
KEYWORDS = {"if", "for", "while", "return", "new", "typeof", "delete", "void"}

# 收集全部导出符号（src 模块的 export function/const/let），记录符号→模块
exports = {}
for f in os.listdir(SRC):
    if not f.endswith(".js"):
        continue
    t = open(os.path.join(SRC, f), encoding="utf-8").read()
    for sym in re.findall(r"^export (?:async )?(?:function|const|let) (\w+)", t, re.M):
        exports[sym] = f

# 收集引用（模板静态 + src 字符串）
needed = set()
for d in (TPL, SRC):
    for f in os.listdir(d):
        if not (f.endswith(".html") or f.endswith(".js")):
            continue
        t = open(os.path.join(d, f), encoding="utf-8").read()
        for m in re.finditer(r'on[a-z]+\s*=\s*"([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(', t):
            g = m.group(1)
            if g not in KEYWORDS and g in exports:
                needed.add(g)

# 更新 main.js 标记区间
src = open(MAIN, encoding="utf-8").read()
start = src.index("// ===== 模板 onclick 等引用的全局函数（脚本自动生成，勿手改） =====")
end = src.index("// ===== 页面生命周期 =====")
block = "// ===== 模板 onclick 等引用的全局函数（脚本自动生成，勿手改） =====\n" + \
        "\n".join(f"window.{g} = {g};" for g in sorted(needed)) + "\n\n"
src = src[:start] + block + src[end:]

# main.js 顶部 import 块重建：按标识符扫描分析依赖（不依赖旧 import 行，
# 旧行可能已被污染）；只 import exports 表中真实存在的符号，天然过滤 JS 内建名。
import re as _re
lines = src.split("\n")
import_idxs = [i for i, l in enumerate(lines) if l.startswith("import ") and 'from "./' in l]
body = "\n".join(l for i, l in enumerate(lines) if i not in import_idxs)
body = _re.sub(r"/\*.*?\*/", "", body, flags=_re.S)  # 去块注释（注释里的词不 import）
need_by_mod = {}
for sym in _re.findall(r"\b[a-zA-Z_$][a-zA-Z0-9_$]*\b", body):
    mod = exports.get(sym)
    if mod and mod != "main.js":
        need_by_mod.setdefault(mod, set()).add(sym)
# window 导出引用的符号强制补齐（扫描已覆盖，这里兜底）
for g in needed:
    mod = exports.get(g)
    if mod and mod != "main.js":
        need_by_mod.setdefault(mod, set()).add(g)
new_imports = []
for mod in sorted(need_by_mod):
    syms = sorted(need_by_mod[mod])
    new_imports.append(f'import {{ {", ".join(syms)} }} from "./{mod}";')
if import_idxs:
    first, last = import_idxs[0], import_idxs[-1]
    lines = lines[:first] + new_imports + lines[last + 1:]
else:
    lines = new_imports + lines
src = "\n".join(lines)
open(MAIN, "w", encoding="utf-8").write(src)

missing = sorted(needed - set(re.findall(r"^window\.(\w+)\s*=", src, re.M)))
if missing:
    print("错误：以下 onclick 引用未导出到 window:", ", ".join(missing), file=sys.stderr)
    sys.exit(1)
print(f"window 全局导出 {len(needed)} 个（模板静态 + 动态按钮）")
