import { describe, expect, it, vi } from "vitest";

import {
  buildContextReference,
  handleContextHandoff,
} from "../../src/extension/handle-context-handoff.js";

/** True if the string carries a C0 control character (U+0000–U+001F) or DEL
 *  (U+007F) — the bytes that must never reach terminal.sendText / the clipboard.
 *  Char-code check (not a regex literal) to avoid embedding control chars here. */
const hasControlChar = (s: string): boolean =>
  Array.from(s).some((c) => {
    const code = c.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });

describe("buildContextReference", () => {
  it("returns a whole-file reference when there is no selection", () => {
    expect(buildContextReference("docs/a.md", false, 3, 7)).toBe("@docs/a.md");
  });
  it("returns a single-line reference when start === end", () => {
    expect(buildContextReference("docs/a.md", true, 4, 4)).toBe("@docs/a.md#L4");
  });
  it("returns a range reference for a multi-line selection", () => {
    expect(buildContextReference("docs/a.md", true, 2, 7)).toBe("@docs/a.md#L2-7");
  });

  it("strips C0 control characters and DEL so no embedded newline reaches the reference", () => {
    // A hostile POSIX filename can embed \n/\r; delivered via terminal.sendText
    // (which suppresses only the TRAILING newline) an embedded newline lands as
    // Enter → arbitrary shell exec. Strip C0 (U+0000–U+001F) + DEL (U+007F) at
    // reference-build time so the reference is a single line with no control bytes.
    const ref = buildContextReference("evil\nrm -rf ~\r\n.md", false, 1, 1);
    expect(ref).toBe("@evilrm -rf ~.md");
    expect(hasControlChar(ref)).toBe(false);
    expect(ref.split("\n")).toHaveLength(1);
  });

  it("strips every C0 control character and DEL, keeping the line suffix intact", () => {
    // U+0000–U+001F (the full C0 block) plus U+007F (DEL) — pins the code !== 0x7f
    // branch alongside the C0 range so DEL is provably stripped, not just the C0s.
    const c0 = Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(i)).join("");
    const controls = `${c0}${String.fromCharCode(0x7f)}`;
    const ref = buildContextReference(`a${controls}b.md`, true, 3, 3);
    expect(ref).toBe("@ab.md#L3");
    expect(hasControlChar(ref)).toBe(false);
  });
});

type FakeTerminal = { name: string };

function deps(overrides: Partial<Parameters<typeof handleContextHandoff<FakeTerminal>>[1]> = {}) {
  const calls: {
    clipboard: string[];
    commands: string[];
    info: string[];
    warn: string[];
    error: string[];
    terminalText: string[];
    sentTo: FakeTerminal[];
    shown: FakeTerminal[];
  } = {
    clipboard: [],
    commands: [],
    info: [],
    warn: [],
    error: [],
    terminalText: [],
    sentTo: [],
    shown: [],
  };
  const base = {
    relativePath: "notes/x.md",
    getLineCount: () => 10,
    isDirty: false,
    save: vi.fn(async () => true),
    writeClipboard: vi.fn(async (t: string) => {
      calls.clipboard.push(t);
    }),
    executeCommand: vi.fn(async (id: string) => {
      calls.commands.push(id);
    }),
    showInfo: vi.fn(async (m: string) => {
      calls.info.push(m);
    }),
    showWarn: vi.fn(async (m: string) => {
      calls.warn.push(m);
    }),
    showError: vi.fn(async (m: string) => {
      calls.error.push(m);
    }),
    // Default: no Claude terminal → exercises the clipboard fallback path so the
    // pre-existing tests below keep asserting the unchanged fallback behaviour.
    findClaudeTerminal: vi.fn((): FakeTerminal | undefined => undefined),
    sendTerminalText: vi.fn((t: FakeTerminal, text: string) => {
      calls.sentTo.push(t);
      calls.terminalText.push(text);
    }),
    showTerminal: vi.fn((t: FakeTerminal) => {
      calls.shown.push(t);
    }),
    // Default: no Claude Code panel visible / open → the terminal tier runs and
    // the tier-2 fallback spawns nothing. Override to exercise the panel paths.
    isClaudePanelVisible: vi.fn(() => false),
    isClaudePanelOpen: vi.fn(() => false),
  };
  return { calls, deps: { ...base, ...overrides } };
}

describe("handleContextHandoff", () => {
  it("copies a range reference and runs NO surface command when no Claude panel is open", async () => {
    const { calls, deps: d } = deps();
    await handleContextHandoff({ hasSelection: true, startLine: 2, endLine: 5 }, d);
    expect(calls.clipboard).toEqual(["@notes/x.md#L2-5"]);
    // No panel open → Quoll never spawns one (the old editor.open behaviour that
    // popped a rogue panel + threw "Webview is disposed" is gone).
    expect(calls.commands).toEqual([]);
    expect(calls.info).toEqual([expect.stringContaining("@notes/x.md#L2-5")]);
    expect(calls.warn).toEqual([]);
    expect(calls.error).toEqual([]);
  });

  it("focuses an already-open Claude panel (focus only — never opens a new one)", async () => {
    const { calls, deps: d } = deps({ isClaudePanelOpen: () => true });
    await handleContextHandoff({ hasSelection: true, startLine: 2, endLine: 5 }, d);
    expect(calls.clipboard).toEqual(["@notes/x.md#L2-5"]);
    // Exactly the focus command — NOT editor.open (which would create a panel).
    expect(calls.commands).toEqual(["claude-vscode.focus"]);
    expect(calls.info).toEqual([expect.stringContaining("@notes/x.md#L2-5")]);
    expect(calls.warn).toEqual([]);
    expect(calls.error).toEqual([]);
  });

  it("a VISIBLE Claude panel takes precedence over a terminal (hands to the panel, not the terminal)", async () => {
    // The regression the user hit: a background CLI terminal always matched and
    // stole the handoff even while the user was looking at the panel. When the
    // panel is the active/visible tab it now wins, and the terminal is never
    // even consulted.
    const findClaudeTerminal = vi.fn(() => ({ name: "zsh" }));
    const { calls, deps: d } = deps({
      isClaudePanelVisible: () => true,
      isClaudePanelOpen: () => true,
      findClaudeTerminal,
    });
    await handleContextHandoff({ hasSelection: true, startLine: 2, endLine: 5 }, d);
    // Panel path: clipboard + focus, NO terminal insertion.
    expect(calls.terminalText).toEqual([]);
    expect(calls.sentTo).toEqual([]);
    expect(calls.clipboard).toEqual(["@notes/x.md#L2-5"]);
    expect(calls.commands).toEqual(["claude-vscode.focus"]);
    expect(calls.info).toEqual([expect.stringContaining("@notes/x.md#L2-5")]);
    // The visible panel short-circuits ABOVE the terminal search.
    expect(findClaudeTerminal).not.toHaveBeenCalled();
  });

  it("an open-but-HIDDEN panel does NOT steal the handoff from the terminal", async () => {
    // Panel parked in a background tab (open, not visible) + a terminal present
    // → the terminal still wins (direct insert), no panel focus, no toast.
    const terminal = { name: "zsh" };
    const { calls, deps: d } = deps({
      isClaudePanelVisible: () => false,
      isClaudePanelOpen: () => true,
      findClaudeTerminal: () => terminal,
    });
    await handleContextHandoff({ hasSelection: true, startLine: 2, endLine: 5 }, d);
    expect(calls.terminalText).toEqual(["@notes/x.md#L2-5"]);
    expect(calls.sentTo).toEqual([terminal]);
    expect(calls.commands).toEqual([]); // terminal path — no panel focus
    expect(calls.info).toEqual([]); // no toast on the terminal path
  });

  it("saves a dirty buffer before building the reference", async () => {
    const order: string[] = [];
    const save = vi.fn(async () => {
      order.push("save");
      return true;
    });
    const writeClipboard = vi.fn(async () => {
      order.push("clipboard");
    });
    const { deps: d } = deps({ isDirty: true, save, writeClipboard });
    await handleContextHandoff({ hasSelection: true, startLine: 1, endLine: 1 }, d);
    expect(save).toHaveBeenCalledOnce();
    expect(order).toEqual(["save", "clipboard"]);
  });

  it("does not save a clean buffer", async () => {
    const { deps: d } = deps({ isDirty: false });
    await handleContextHandoff({ hasSelection: false, startLine: 1, endLine: 1 }, d);
    expect(d.save).not.toHaveBeenCalled();
  });

  it("clamps out-of-range lines to the document line count", async () => {
    const { calls, deps: d } = deps({ getLineCount: () => 4 });
    await handleContextHandoff({ hasSelection: true, startLine: 99, endLine: 999 }, d);
    expect(calls.clipboard).toEqual(["@notes/x.md#L4"]);
  });

  it("orders a reversed range and clamps the low end to 1", async () => {
    const { calls, deps: d } = deps({ getLineCount: () => 10 });
    await handleContextHandoff({ hasSelection: true, startLine: 8, endLine: 0 }, d);
    // endLine 0 clamps to 1, then ordered → L1-8
    expect(calls.clipboard).toEqual(["@notes/x.md#L1-8"]);
  });

  it("clamps to the POST-save line count (save participant shrank the file)", async () => {
    // Pre-save the doc has 10 lines; a save participant (e.g. format-on-save)
    // trims it to 4. getLineCount is read AFTER save, so an endLine of 8 must
    // clamp to the post-save count (4), not the pre-save 10 — the @-mention
    // resolves against the saved file.
    let lines = 10;
    const save = vi.fn(async () => {
      lines = 4;
      return true;
    });
    const { calls, deps: d } = deps({ isDirty: true, save, getLineCount: () => lines });
    await handleContextHandoff({ hasSelection: true, startLine: 2, endLine: 8 }, d);
    expect(calls.clipboard).toEqual(["@notes/x.md#L2-4"]);
  });

  it("still copies + succeeds when the panel focus command rejects (best-effort)", async () => {
    const executeCommand = vi.fn(async () => {
      throw new Error("command 'claude-vscode.focus' not found");
    });
    const { calls, deps: d } = deps({ isClaudePanelOpen: () => true, executeCommand });
    await handleContextHandoff({ hasSelection: true, startLine: 1, endLine: 2 }, d);
    expect(calls.clipboard).toEqual(["@notes/x.md#L1-2"]);
    expect(calls.info.length).toBe(1);
    expect(calls.error).toEqual([]);
  });

  it("aborts with a warning when a dirty buffer fails to save (returns false)", async () => {
    const save = vi.fn(async () => false);
    const { calls, deps: d } = deps({ isDirty: true, save });
    await handleContextHandoff({ hasSelection: true, startLine: 1, endLine: 2 }, d);
    expect(save).toHaveBeenCalledOnce();
    expect(calls.clipboard).toEqual([]); // no stale reference handed off
    expect(calls.commands).toEqual([]); // no open/focus
    expect(calls.info).toEqual([]); // no false success
    expect(calls.warn.length).toBe(1);
  });

  it("aborts with a warning when save throws", async () => {
    const save = vi.fn(async () => {
      throw new Error("save failed");
    });
    const { calls, deps: d } = deps({ isDirty: true, save });
    await handleContextHandoff({ hasSelection: false, startLine: 1, endLine: 1 }, d);
    expect(calls.clipboard).toEqual([]);
    expect(calls.warn.length).toBe(1);
  });

  it("aborts with an error when the clipboard write fails", async () => {
    const writeClipboard = vi.fn(async () => {
      throw new Error("clipboard unavailable");
    });
    const { calls, deps: d } = deps({ writeClipboard });
    await handleContextHandoff({ hasSelection: true, startLine: 1, endLine: 2 }, d);
    expect(calls.commands).toEqual([]); // no open/focus on clipboard failure
    expect(calls.info).toEqual([]); // no false success
    expect(calls.error.length).toBe(1);
  });

  it("falls back to clipboard (no terminal insertion) when findClaudeTerminal returns undefined", async () => {
    // Contract pin: a match miss → undefined → clipboard path. Nothing is ever
    // sent to a terminal (no activeTerminal misfire).
    const { calls, deps: d } = deps({ findClaudeTerminal: () => undefined });
    await handleContextHandoff({ hasSelection: true, startLine: 2, endLine: 5 }, d);
    expect(calls.terminalText).toEqual([]); // no insertion
    expect(calls.sentTo).toEqual([]);
    expect(calls.shown).toEqual([]);
    // Clipboard + paste toast. No surface command: with no panel open Quoll does
    // NOT spawn one (the regression fix — a rogue panel used to pop here).
    expect(calls.clipboard).toEqual(["@notes/x.md#L2-5"]);
    expect(calls.commands).toEqual([]);
    expect(calls.info).toEqual([expect.stringContaining("paste")]);
    expect(calls.warn).toEqual([]);
    expect(calls.error).toEqual([]);
  });

  it("awaits an async findClaudeTerminal (process-scan path) and inserts into the resolved terminal", async () => {
    // The process-based finder returns a Promise; the handler must await it.
    const terminal = { name: "zsh" }; // a plain shell terminal (name does NOT match /claude/i)
    const { calls, deps: d } = deps({
      findClaudeTerminal: () => Promise.resolve(terminal),
    });
    await handleContextHandoff({ hasSelection: true, startLine: 2, endLine: 5 }, d);
    expect(calls.terminalText).toEqual(["@notes/x.md#L2-5"]);
    expect(calls.sentTo).toEqual([terminal]);
    expect(calls.shown).toEqual([terminal]);
    expect(calls.commands).toEqual([]); // terminal path skips the panel focus
  });

  it("inserts into the Claude terminal and skips the open commands when a terminal is found", async () => {
    const terminal = { name: "claude" };
    const { calls, deps: d } = deps({ findClaudeTerminal: () => terminal });
    await handleContextHandoff({ hasSelection: true, startLine: 2, endLine: 5 }, d);
    // Reference inserted into the terminal (no newline) and the terminal surfaced.
    expect(calls.terminalText).toEqual(["@notes/x.md#L2-5"]);
    expect(calls.sentTo).toEqual([terminal]);
    expect(calls.shown).toEqual([terminal]);
    // No new-tab open commands on the direct-insert path.
    expect(calls.commands).toEqual([]);
    // Clipboard still written as a paste safety net.
    expect(calls.clipboard).toEqual(["@notes/x.md#L2-5"]);
    // No success toast on the terminal path — the reference is already visible in
    // the surfaced terminal's input line, so a notification would be redundant.
    expect(calls.info).toEqual([]);
    expect(calls.warn).toEqual([]);
    expect(calls.error).toEqual([]);
  });

  it("does not abort on the terminal path when the clipboard insurance write fails", async () => {
    const terminal = { name: "claude" };
    const writeClipboard = vi.fn(async () => {
      throw new Error("clipboard unavailable");
    });
    const { calls, deps: d } = deps({ findClaudeTerminal: () => terminal, writeClipboard });
    await handleContextHandoff({ hasSelection: true, startLine: 1, endLine: 2 }, d);
    // Terminal insertion succeeded → still a success, no error abort.
    expect(calls.terminalText).toEqual(["@notes/x.md#L1-2"]);
    expect(calls.shown).toEqual([terminal]);
    expect(calls.commands).toEqual([]);
    expect(calls.info).toEqual([]); // no toast on the terminal path
    expect(calls.error).toEqual([]);
  });

  it("still aborts on a failed save before reaching the terminal path", async () => {
    const terminal = { name: "claude" };
    const save = vi.fn(async () => false);
    const { calls, deps: d } = deps({ isDirty: true, save, findClaudeTerminal: () => terminal });
    await handleContextHandoff({ hasSelection: true, startLine: 1, endLine: 2 }, d);
    expect(save).toHaveBeenCalledOnce();
    expect(calls.terminalText).toEqual([]); // no insertion on stale disk
    expect(calls.shown).toEqual([]);
    expect(calls.clipboard).toEqual([]);
    expect(calls.info).toEqual([]); // no false success
    expect(calls.warn.length).toBe(1);
  });

  it("sanitizes control characters from the reference on BOTH the terminal and clipboard paths", async () => {
    // A hostile POSIX filename embeds \n so its @-mention would carry an Enter
    // into terminal.sendText (arbitrary shell exec) and into the clipboard for a
    // later paste. Both delivery paths consume the single sanitized reference.
    const terminal = { name: "claude" };
    const { calls, deps: d } = deps({
      relativePath: "evil\nrm -rf ~\n.md",
      findClaudeTerminal: () => terminal,
    });
    await handleContextHandoff({ hasSelection: false, startLine: 1, endLine: 1 }, d);
    const reference = "@evilrm -rf ~.md";
    expect(calls.terminalText).toEqual([reference]);
    expect(calls.clipboard).toEqual([reference]);
    for (const sent of [...calls.terminalText, ...calls.clipboard]) {
      expect(hasControlChar(sent)).toBe(false);
    }
  });
});
