import { describe, expect, it, vi } from "vitest";

import {
  buildContextReference,
  CLAUDE_INSERT_AT_MENTIONED_COMMAND,
  type HandoffRevealSelection,
  handleContextHandoff,
} from "../../src/extension/handle-context-handoff.js";

/** True if the string carries a C0 control character (U+0000–U+001F) or DEL
 *  (U+007F) — the bytes that must never reach the clipboard (a later paste
 *  into the Claude Code CLI terminal delivers an embedded newline as Enter).
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
    // A hostile POSIX filename can embed \n/\r; pasted into the Claude Code CLI
    // terminal an embedded newline lands as Enter → arbitrary shell exec. Strip
    // C0 (U+0000–U+001F) + DEL (U+007F) at reference-build time so the
    // reference is a single line with no control bytes.
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

// NOTE: the v2 terminal tier is GONE — HandleContextHandoffDeps carries no
// findClaudeTerminal / sendTerminalText / showTerminal, so passing them in an
// override is a compile error (excess property). Delegation reaches the CLI
// via Claude Code's own at_mentioned channel instead.
function deps(overrides: Partial<Parameters<typeof handleContextHandoff>[1]> = {}) {
  const calls: {
    clipboard: string[];
    commands: string[];
    info: string[];
    warn: string[];
    error: string[];
    reveals: HandoffRevealSelection[];
    cleanups: number;
    /** Interleaved call order across reveal / command / cleanup / clipboard —
     *  pins the tier-0 sequencing contract. */
    order: string[];
  } = {
    clipboard: [],
    commands: [],
    info: [],
    warn: [],
    error: [],
    reveals: [],
    cleanups: 0,
    order: [],
  };
  const base = {
    relativePath: "notes/x.md",
    getLineCount: () => 10,
    isDirty: false,
    save: vi.fn(async () => true),
    writeClipboard: vi.fn(async (t: string) => {
      calls.clipboard.push(t);
      calls.order.push("clipboard");
    }),
    executeCommand: vi.fn(async (id: string) => {
      calls.commands.push(id);
      calls.order.push(`command:${id}`);
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
    // Default: the reveal succeeds and every command resolves → exercises the
    // tier-0 delegation happy path. Fallback tests override executeCommand /
    // revealForMention to reject.
    revealForMention: vi.fn(async (sel: HandoffRevealSelection) => {
      calls.reveals.push(sel);
      calls.order.push("reveal");
      return async () => {
        calls.cleanups += 1;
        calls.order.push("cleanup");
      };
    }),
  };
  return { calls, deps: { ...base, ...overrides } };
}

/** executeCommand override that rejects ONLY the tier-0 insert command
 *  (Claude Code missing / too old) and records every attempted id — drives
 *  the handler onto the v1 clipboard fallback tier. */
function rejectInsertExecuteCommand() {
  const attempted: string[] = [];
  const executeCommand = vi.fn(async (id: string) => {
    attempted.push(id);
    if (id === CLAUDE_INSERT_AT_MENTIONED_COMMAND) {
      throw new Error(`command '${id}' not found`);
    }
  });
  return { attempted, executeCommand };
}

describe("handleContextHandoff — tier 0 delegation", () => {
  it("reveals the doc, runs insertAtMentioned, cleans up, then writes the clipboard insurance", async () => {
    const { calls, deps: d } = deps();
    await handleContextHandoff({ hasSelection: true, startLine: 2, endLine: 5 }, d);
    // Order contract: reveal → insert command → cleanup → insurance write.
    expect(calls.order).toEqual([
      "reveal",
      `command:${CLAUDE_INSERT_AT_MENTIONED_COMMAND}`,
      "cleanup",
      "clipboard",
    ]);
    // ONLY the insert command runs — no fallback open/focus commands.
    expect(calls.commands).toEqual([CLAUDE_INSERT_AT_MENTIONED_COMMAND]);
    expect(calls.clipboard).toEqual(["@notes/x.md#L2-5"]);
    // No toast on the delegation path — the mention lands in the composer/CLI.
    expect(calls.info).toEqual([]);
    expect(calls.warn).toEqual([]);
    expect(calls.error).toEqual([]);
  });

  it("treats a failed clipboard insurance write as non-fatal", async () => {
    const writeClipboard = vi.fn(async () => {
      throw new Error("clipboard unavailable");
    });
    const { calls, deps: d } = deps({ writeClipboard });
    await handleContextHandoff({ hasSelection: true, startLine: 1, endLine: 2 }, d);
    // Delegation succeeded → still a success: no error abort, no fallback tier.
    expect(calls.commands).toEqual([CLAUDE_INSERT_AT_MENTIONED_COMMAND]);
    expect(calls.cleanups).toBe(1);
    expect(calls.info).toEqual([]);
    expect(calls.error).toEqual([]);
  });

  it("passes a no-selection payload through with hasSelection false", async () => {
    const { calls, deps: d } = deps();
    await handleContextHandoff({ hasSelection: false, startLine: 1, endLine: 1 }, d);
    expect(calls.reveals).toEqual([{ hasSelection: false, startLine: 1, endLine: 1 }]);
    expect(calls.clipboard).toEqual(["@notes/x.md"]);
  });

  it("passes a single-line selection to revealForMention unchanged", async () => {
    const { calls, deps: d } = deps();
    await handleContextHandoff({ hasSelection: true, startLine: 4, endLine: 4 }, d);
    expect(calls.reveals).toEqual([{ hasSelection: true, startLine: 4, endLine: 4 }]);
  });

  it("passes a reversed, out-of-range selection clamped and ordered", async () => {
    // startLine 99 clamps to lineCount 10; endLine 2 stays; then ordered → 2..10.
    const { calls, deps: d } = deps({ getLineCount: () => 10 });
    await handleContextHandoff({ hasSelection: true, startLine: 99, endLine: 2 }, d);
    expect(calls.reveals).toEqual([{ hasSelection: true, startLine: 2, endLine: 10 }]);
  });

  it("saves a dirty buffer BEFORE revealing (the on-disk bytes are the mention target)", async () => {
    const order: string[] = [];
    const save = vi.fn(async () => {
      order.push("save");
      return true;
    });
    const revealForMention = vi.fn(async () => {
      order.push("reveal");
      return async () => {};
    });
    const { deps: d } = deps({ isDirty: true, save, revealForMention });
    await handleContextHandoff({ hasSelection: true, startLine: 1, endLine: 1 }, d);
    expect(save).toHaveBeenCalledOnce();
    expect(order).toEqual(["save", "reveal"]);
  });

  it("runs cleanup even when the insert command rejects, then falls back", async () => {
    const { attempted, executeCommand } = rejectInsertExecuteCommand();
    const { calls, deps: d } = deps({ executeCommand });
    await handleContextHandoff({ hasSelection: true, startLine: 2, endLine: 5 }, d);
    // Cleanup ran despite the rejection (finally), BEFORE the fallback tier.
    expect(calls.cleanups).toBe(1);
    expect(calls.order).toEqual(["reveal", "cleanup", "clipboard"]);
    // Fallback tier ran verbatim: insert attempted, then open/focus commands.
    expect(attempted).toEqual([
      CLAUDE_INSERT_AT_MENTIONED_COMMAND,
      "claude-vscode.editor.open",
      "claude-vscode.focus",
    ]);
    expect(calls.clipboard).toEqual(["@notes/x.md#L2-5"]);
    expect(calls.info).toEqual([expect.stringContaining("paste")]);
    expect(calls.error).toEqual([]);
  });

  it("falls back to the clipboard tier when the reveal itself rejects", async () => {
    const revealForMention = vi.fn(async (): Promise<() => Promise<void>> => {
      throw new Error("showTextDocument failed");
    });
    const { calls, deps: d } = deps({ revealForMention });
    await handleContextHandoff({ hasSelection: true, startLine: 2, endLine: 5 }, d);
    expect(revealForMention).toHaveBeenCalledOnce();
    // No reveal → no cleanup, and the insert command is never attempted.
    expect(calls.cleanups).toBe(0);
    expect(calls.commands).toEqual(["claude-vscode.editor.open", "claude-vscode.focus"]);
    expect(calls.clipboard).toEqual(["@notes/x.md#L2-5"]);
    expect(calls.info).toEqual([expect.stringContaining("paste")]);
    expect(calls.error).toEqual([]);
  });
});

describe("handleContextHandoff — fallback tier (v1, verbatim)", () => {
  it("copies a range reference, opens+focuses Claude Code, and toasts", async () => {
    const { attempted, executeCommand } = rejectInsertExecuteCommand();
    const { calls, deps: d } = deps({ executeCommand });
    await handleContextHandoff({ hasSelection: true, startLine: 2, endLine: 5 }, d);
    expect(calls.clipboard).toEqual(["@notes/x.md#L2-5"]);
    expect(attempted.slice(1)).toEqual(["claude-vscode.editor.open", "claude-vscode.focus"]);
    expect(calls.info).toEqual([expect.stringContaining("@notes/x.md#L2-5")]);
    expect(calls.warn).toEqual([]);
    expect(calls.error).toEqual([]);
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
    expect(calls.reveals).toEqual([{ hasSelection: true, startLine: 2, endLine: 4 }]);
  });

  it("still copies + succeeds when EVERY Claude Code command rejects (best-effort)", async () => {
    const executeCommand = vi.fn(async () => {
      throw new Error("command not found");
    });
    const { calls, deps: d } = deps({ executeCommand });
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
    expect(calls.reveals).toEqual([]); // save-first gates the delegation too
    expect(calls.clipboard).toEqual([]); // no stale reference handed off
    expect(calls.commands).toEqual([]); // no insert, no open/focus
    expect(calls.info).toEqual([]); // no false success
    expect(calls.warn.length).toBe(1);
  });

  it("aborts with a warning when save throws", async () => {
    const save = vi.fn(async () => {
      throw new Error("save failed");
    });
    const { calls, deps: d } = deps({ isDirty: true, save });
    await handleContextHandoff({ hasSelection: false, startLine: 1, endLine: 1 }, d);
    expect(calls.reveals).toEqual([]);
    expect(calls.clipboard).toEqual([]);
    expect(calls.warn.length).toBe(1);
  });

  it("aborts with an error when the FALLBACK clipboard write fails", async () => {
    // On the fallback tier the clipboard IS the contract — a failure there is
    // fatal (unlike the tier-0 insurance write).
    const { attempted, executeCommand } = rejectInsertExecuteCommand();
    const writeClipboard = vi.fn(async () => {
      throw new Error("clipboard unavailable");
    });
    const { calls, deps: d } = deps({ executeCommand, writeClipboard });
    await handleContextHandoff({ hasSelection: true, startLine: 1, endLine: 2 }, d);
    expect(attempted).toEqual([CLAUDE_INSERT_AT_MENTIONED_COMMAND]); // no open/focus
    expect(calls.info).toEqual([]); // no false success
    expect(calls.error.length).toBe(1);
  });

  it("sanitizes control characters from the reference on BOTH the insurance and fallback paths", async () => {
    // A hostile POSIX filename embeds \n so its @-mention would carry an Enter
    // into a later terminal paste. Both clipboard deliveries (tier-0 insurance
    // and fallback copy) consume the single sanitized reference.
    const reference = "@evilrm -rf ~.md";
    const insurance = deps({ relativePath: "evil\nrm -rf ~\n.md" });
    await handleContextHandoff({ hasSelection: false, startLine: 1, endLine: 1 }, insurance.deps);
    expect(insurance.calls.clipboard).toEqual([reference]);

    const { executeCommand } = rejectInsertExecuteCommand();
    const fallback = deps({ relativePath: "evil\nrm -rf ~\n.md", executeCommand });
    await handleContextHandoff({ hasSelection: false, startLine: 1, endLine: 1 }, fallback.deps);
    expect(fallback.calls.clipboard).toEqual([reference]);

    for (const sent of [...insurance.calls.clipboard, ...fallback.calls.clipboard]) {
      expect(hasControlChar(sent)).toBe(false);
    }
  });
});
