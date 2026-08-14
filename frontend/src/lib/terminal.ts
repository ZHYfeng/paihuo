import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

export type TerminalMode = "live" | "replay" | "logs";

export class TerminalAdapter {
  private terminal: Terminal;
  private fitAddon = new FitAddon();
  private observer?: ResizeObserver;
  private disposed = false;
  private onInput?: (data: string) => void;
  private onResize?: (cols: number, rows: number) => void;
  private mode: TerminalMode;

  constructor(private element: HTMLElement, options: {
    onInput?: (data: string) => void;
    onResize?: (cols: number, rows: number) => void;
    mode?: TerminalMode;
    cols?: number;
    rows?: number;
  } = {}) {
    this.onInput = options.onInput;
    this.onResize = options.onResize;
    this.mode = options.mode || "logs";
    const interactive = this.mode !== "logs";
    this.terminal = new Terminal({
      convertEol: true,
      cursorBlink: Boolean(this.onInput),
      disableStdin: !this.onInput,
      fontFamily: '"Symbols Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.28,
      scrollback: interactive ? 3000 : 10000,
      cols: options.cols || 80,
      rows: options.rows || 24,
      theme: { background: "#080d15", foreground: "#dbe5f3", cursor: "#80a0ff", selectionBackground: "#35538b88" }
    });
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(element);
    if (this.onInput) this.terminal.onData(this.onInput);
    this.observer = new ResizeObserver(() => this.fit());
    this.observer.observe(element);
    requestAnimationFrame(() => this.fit());
  }

  // 批处理日志：按行补 \r\n；term 流保留原始字节（含 TUI 光标控制）。
  replaceLogs(logs: Array<{ stream?: string; content: string }>) {
    if (this.disposed) return;
    const parts: string[] = [];
    for (const log of logs) {
      if (log.stream === "term") parts.push(log.content);
      else parts.push(log.content.replace(/\n/g, "\r\n"));
    }
    this.terminal.reset();
    this.terminal.write(parts.join(""));
  }

  appendContent(content: string) {
    if (!this.disposed) this.terminal.write(content.replace(/\n/g, "\r\n"));
  }

  appendRaw(content: string) {
    if (!this.disposed) this.terminal.write(content);
  }

  writePlaceholder(text: string) {
    if (this.disposed) return;
    this.terminal.reset();
    this.terminal.write(`\x1b[90m${text}\x1b[0m\r\n`);
  }

  focus() { this.terminal.focus(); }

  get cols() { return this.terminal.cols; }
  get rows() { return this.terminal.rows; }

  visibleText(): string {
    if (this.disposed) return "";
    const buffer = this.terminal.buffer.active;
    const start = buffer.viewportY;
    const end = Math.min(buffer.length, start + this.terminal.rows);
    const lines: string[] = [];
    for (let row = start; row < end; row++) {
      lines.push(buffer.getLine(row)?.translateToString(true) || "");
    }
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    return lines.join("\n");
  }

  scrollToBottom() { this.terminal.scrollToBottom(); }

  scrollToTop() { this.terminal.scrollToTop(); }

  resize(cols: number, rows: number) {
    if (this.disposed) return;
    this.terminal.resize(cols, rows);
    this.onResize?.(this.terminal.cols, this.terminal.rows);
  }

  // replay 模式：录制帧不能 reflow，按容器缩放居中（transform）。
  fit() {
    if (this.disposed || this.element.clientWidth === 0 || this.element.clientHeight === 0) return;
    if (this.mode === "replay") {
      this.scaleToContainer();
      return;
    }
    this.fitAddon.fit();
    if (this.mode === "live") this.onResize?.(this.terminal.cols, this.terminal.rows);
  }

  private scaleToContainer() {
    const el = this.terminal.element;
    if (!el) return;
    const host = this.element;
    const rowsEl = el.querySelector(".xterm-rows") as HTMLElement | null;
    const natW = rowsEl?.offsetWidth || el.offsetWidth;
    const natH = rowsEl?.offsetHeight || el.offsetHeight;
    const style = getComputedStyle(el);
    const px = (value: string) => Number.parseFloat(value) || 0;
    const padW = px(style.paddingLeft) + px(style.paddingRight) + el.offsetWidth - el.clientWidth;
    const padH = px(style.paddingTop) + px(style.paddingBottom) + el.offsetHeight - el.clientHeight;
    const cw = host.clientWidth, ch = host.clientHeight;
    if (!natW || !natH || !cw || !ch) return;
    const visW = natW + padW, visH = natH + padH;
    const s = Math.min(cw / visW, ch / visH);
    el.style.transformOrigin = "0 0";
    el.style.transform = `scale(${s}) translate(${(cw - visW * s) / 2 / s}px, ${(ch - visH * s) / 2 / s}px)`;
  }

  dispose() {
    this.disposed = true;
    this.observer?.disconnect();
    this.terminal.dispose();
  }
}
