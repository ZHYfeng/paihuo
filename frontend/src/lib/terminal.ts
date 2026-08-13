import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

export class TerminalAdapter {
  private terminal: Terminal;
  private fitAddon = new FitAddon();
  private observer?: ResizeObserver;
  private disposed = false;

  constructor(private element: HTMLElement, onInput?: (data: string) => void, private onResize?: (cols: number, rows: number) => void) {
    this.terminal = new Terminal({
      convertEol: true,
      cursorBlink: Boolean(onInput),
      disableStdin: !onInput,
      fontFamily: '"Symbols Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.28,
      scrollback: 10000,
      theme: { background: "#080d15", foreground: "#dbe5f3", cursor: "#80a0ff", selectionBackground: "#35538b88" }
    });
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(element);
    if (onInput) this.terminal.onData(onInput);
    this.observer = new ResizeObserver(() => this.fit());
    this.observer.observe(element);
    requestAnimationFrame(() => this.fit());
  }

  replace(content: string) {
    if (this.disposed) return;
    this.terminal.reset();
    this.terminal.write(content.replace(/\n/g, "\r\n"));
  }

  append(content: string) {
    if (!this.disposed) this.terminal.write(content.replace(/\n/g, "\r\n"));
  }

  focus() { this.terminal.focus(); }

  fit() {
    if (this.disposed || this.element.clientWidth === 0 || this.element.clientHeight === 0) return;
    this.fitAddon.fit();
    this.onResize?.(this.terminal.cols, this.terminal.rows);
  }

  dispose() {
    this.disposed = true;
    this.observer?.disconnect();
    this.terminal.dispose();
  }
}
