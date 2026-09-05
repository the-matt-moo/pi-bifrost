import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";

type ResultTheme = Pick<ExtensionContext["ui"]["theme"], "fg">;

/** Overhead lines: top border + title + scroll info + bottom border. */
const CHROME_LINES = 4;
const MIN_VISIBLE_LINES = 5;
const FALLBACK_VISIBLE_LINES = 10;

/** Match legacy Esc plus Kitty CSI-u and xterm modifyOtherKeys encodings. */
export function isEscapeKey(data: string): boolean {
  return data === "\x1b"
    || /^\x1b\[27(?:;1)?u$/.test(data)
    || data === "\x1b[27;1;27~";
}

export function wrapResultLines(lines: readonly string[], width: number): string[] {
  const safeWidth = Math.max(1, width);
  const wrapped: string[] = [];

  for (const line of lines) {
    if (!line) {
      wrapped.push("");
      continue;
    }

    for (let offset = 0; offset < line.length; offset += safeWidth) {
      wrapped.push(line.slice(offset, offset + safeWidth));
    }
  }

  return wrapped;
}

class ResultViewer {
  private scrollOffset = 0;
  private maxOffset = 0;
  private readonly visibleLines: number;
  private readonly title: string;
  private readonly lines: readonly string[];
  private readonly theme: ResultTheme;
  private readonly done: () => void;
  private readonly requestRender: () => void;
  private readonly keybindings: KeybindingsManager | undefined;

  constructor(
    title: string,
    lines: readonly string[],
    theme: ResultTheme,
    done: () => void,
    requestRender: () => void,
    keybindings?: KeybindingsManager,
    termRows?: number,
  ) {
    this.title = title;
    this.lines = lines;
    this.theme = theme;
    this.done = done;
    this.requestRender = requestRender;
    this.keybindings = keybindings;

    // Match the overlay framework's maxHeight calculation exactly so the
    // rendered output is never clipped.  The framework does:
    //   availHeight = termRows - marginTop - marginBottom   (margin=1 → termRows-2)
    //   maxHeight   = min(round(fraction * termRows), availHeight)
    // We use 90% of terminal height as the overlay maxHeight, then subtract
    // our 4 chrome lines (top border, title, scroll info, bottom border).
    if (termRows && termRows > 0) {
      const availHeight = termRows - 2;            // margin 1 top + 1 bottom
      const maxHeight = Math.min(Math.round(termRows * 0.9), availHeight);
      this.visibleLines = Math.max(MIN_VISIBLE_LINES, maxHeight - CHROME_LINES);
    } else {
      this.visibleLines = FALLBACK_VISIBLE_LINES;
    }
  }

  handleInput(data: string): void {
    // Use keybindings manager when available (canonical TUI approach),
    // fall back to raw key detection for compatibility.
    const isCancel = this.keybindings
      ? this.keybindings.matches(data, "tui.select.cancel")
      : isEscapeKey(data);
    if (isCancel || data === "\x03") {
      this.done();
      return;
    }

    if (data === "\x1b[A" || data === "k") this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    else if (data === "\x1b[B" || data === "j") this.scrollOffset = Math.min(this.maxOffset, this.scrollOffset + 1);
    else if (data === "\x1b[5~") this.scrollOffset = Math.max(0, this.scrollOffset - MAX_PAGE);
    else if (data === "\x1b[6~") this.scrollOffset = Math.min(this.maxOffset, this.scrollOffset + MAX_PAGE);
    else return;

    this.requestRender();
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 4);
    const lines = wrapResultLines(this.lines, contentWidth);
    this.maxOffset = Math.max(0, lines.length - this.visibleLines);
    this.scrollOffset = Math.min(this.scrollOffset, this.maxOffset);
    const visible = lines.slice(this.scrollOffset, this.scrollOffset + this.visibleLines);
    const border = (text: string) => this.theme.fg("border", text);
    const row = (text: string, color: "text" | "accent" | "dim" = "text") => {
      const padded = text.slice(0, contentWidth).padEnd(contentWidth);
      return `${border("│")} ${this.theme.fg(color, padded)} ${border("│")}`;
    };
    const title = this.title.slice(0, contentWidth);
    const scroll = lines.length > this.visibleLines
      ? `${this.scrollOffset + 1}-${this.scrollOffset + visible.length}/${lines.length} · ↑↓/jk scroll · esc close`
      : "esc close";

    return [
      border(`╭${"─".repeat(contentWidth + 2)}╮`),
      row(title, "accent"),
      row(scroll, "dim"),
      ...visible.map((line) => row(line)),
      ...Array.from({ length: this.visibleLines - visible.length }, () => row("")),
      border(`╰${"─".repeat(contentWidth + 2)}╯`),
    ];
  }

  invalidate(): void {}
}

/** Page-jump size for PgUp/PgDn — half a screen feels more navigable. */
const MAX_PAGE = 10;

export async function showBifrostResult(
  ctx: ExtensionContext,
  title: string,
  lines: readonly string[],
): Promise<boolean> {
  if (!ctx.hasUI || ctx.mode !== "tui") return false;

  await ctx.ui.custom<void>(
    (tui, theme, keybindings, done) =>
      new ResultViewer(title, lines, theme, done, () => tui.requestRender(), keybindings, tui.terminal.rows),
    {
      overlay: true,
      overlayOptions: {
        width: "90%",
        minWidth: 40,
        maxHeight: "90%",
        anchor: "top-center",
        offsetY: 1,
        margin: 1,
      },
    },
  );
  return true;
}
