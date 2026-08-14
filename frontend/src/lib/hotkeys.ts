// 全局快捷键（自旧前端 main.js initShortcuts 移植，适配 React 上下文）：
//   - Ctrl/Cmd+B 折叠/展开侧栏（非输入框）
//   - Escape 关闭当前弹窗（Dialog 由 Radix 处理，这里补 terminal modal）
//   - N/n 在任务页新建任务（未打开详情时）
//   - / 聚焦搜索框（页面注册 target）
// 输入框内不劫持；xterm 内不劫持（终端按键归 CLI）。
import { useEffect } from "react";

export function useHotkeys(options: {
  sidebar?: () => void;
  newTask?: () => void;
  searchRef?: React.RefObject<HTMLElement | null>;
  enabled?: boolean;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.composedPath()[0] as HTMLElement | null;
      if (!target) return;
      if (target.closest(".xterm")) return;
      const tag = target.tagName;
      const inField = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
      if (event.key === "b" && (event.ctrlKey || event.metaKey) && !inField) {
        event.preventDefault();
        options.sidebar?.();
        return;
      }
      if (event.key === "Escape") {
        // Radix Dialog 自带 Esc；这里处理自定义 overlay（如全屏终端）。
        const modal = document.querySelector<HTMLElement>("[role='dialog'][data-state='open']");
        if (modal) return;
        const overlay = document.querySelector<HTMLElement>(".term-modal");
        if (overlay) {
          const close = overlay.closest("[role='dialog']")?.querySelector<HTMLElement>("button[aria-label='关闭']");
          close?.click();
        }
        return;
      }
      if (event.key === "n" || event.key === "N") {
        if (inField) return;
        if (options.enabled === false) return;
        const detailOpen = document.querySelector("#detailShell") || location.pathname.startsWith("/tasks/");
        if (detailOpen) return;
        options.newTask?.();
        return;
      }
      if (event.key === "/" && !inField) {
        const el = options.searchRef?.current;
        if (el) {
          event.preventDefault();
          el.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [options]);
}
