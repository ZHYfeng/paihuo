// 剪贴板写入。非安全上下文（纯 HTTP、非 localhost）没有 Clipboard API，
// 退回隐藏 textarea + execCommand 方案，保证所有复制按钮可用。
export async function copyText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    if (!document.execCommand("copy")) throw new Error("复制失败");
  } finally {
    document.body.removeChild(ta);
  }
}
