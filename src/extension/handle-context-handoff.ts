// Host-side handler for a webview "context-handoff" request. Pure-function
// design (deps injected) so it unit-tests without a live VS Code host —
// mirrors handle-open-external.ts.
//
// The host is the canonical document owner: it builds the reference from its
// OWN document.uri (via workspace.asRelativePath, supplied as deps.relativePath)
// and re-clamps the webview-supplied line numbers to the live document's line
// count. The webview sends only selection geometry; it never sends a path.
//
// Handoff mechanism (v2, tiered) — build the `@<path>#L<a>-<b>` reference, then:
//
//   1. Direct-insert (preferred): if a Claude Code terminal is found
//      (deps.findClaudeTerminal), send the reference straight into its input
//      WITHOUT a newline (the user reviews then presses Enter), surface that
//      terminal, and SKIP the new-tab open commands. The clipboard is still
//      written as a paste safety net, but a failure there is non-fatal (the
//      terminal already has the text) — warn instead of aborting.
//   2. Clipboard fallback (unchanged v1): if no terminal is found, copy the
//      reference (a clipboard failure here is fatal — there is nothing to
//      paste), best-effort open+focus Claude Code, then toast the user to paste.
//
// The terminal path replaces v1's clipboard-then-open-new-tab default: opening a
// new tab read as "a tab popped up" and still required a manual paste. The
// fully-silent insertAtMention path was rejected because it would require
// mirroring the saved file into a native TextEditor (Claude Code's at-mention
// commands read window.activeTextEditor and take no args) and restoring webview
// focus — focus flicker + coupling to Claude Code internals. terminal.sendText
// and terminal.show are rock-stable VS Code APIs with no Claude Code coupling.
//
// COUPLING NOTE (future-proof): the open-command IDs, the reference format, and
// the terminal-name heuristic (host-side, in QuollEditorPanel) are the ONLY
// surface coupled to Claude Code. The constants below are isolated here so a
// future upstream change is a one-file edit. The format is "what Claude Code
// currently accepts as an @-mention" (cross-checked against the shipped
// insertAtMention in extension.js v2.1.193), NOT a contract Claude Code
// publishes — treat the manual smoke + this comment as the canary.

/** Claude Code commands tried, in order, to surface its input for a paste.
 *  Best-effort: each is executed independently and its rejection swallowed,
 *  so a missing Claude Code install never blocks the clipboard handoff. */
export const HANDOFF_OPEN_COMMANDS = ["claude-vscode.editor.open", "claude-vscode.focus"] as const;

export type HandleContextHandoffPayload = {
  hasSelection: boolean;
  startLine: number;
  endLine: number;
};

export type HandleContextHandoffDeps<T> = {
  /** workspace.asRelativePath(document.uri) — host-owned path. */
  relativePath: string;
  /** Live document.lineCount getter — read AFTER save() so the clamp bounds the
   *  range to the file the @-mention actually resolves against (a save
   *  participant, e.g. format-on-save, can add/remove lines). */
  getLineCount: () => number;
  /** document.isDirty — gate the save. */
  isDirty: boolean;
  /** document.save() bound. Resolves false on failure. */
  save: () => Thenable<boolean>;
  /** env.clipboard.writeText bound. */
  writeClipboard: (text: string) => Thenable<void>;
  /** commands.executeCommand bound (single id, no args). */
  executeCommand: (id: string) => Thenable<unknown>;
  /** window.showInformationMessage bound — success toast. */
  showInfo: (message: string) => Thenable<unknown>;
  /** window.showWarningMessage bound — save-failure abort. */
  showWarn: (message: string) => Thenable<unknown>;
  /** window.showErrorMessage bound — clipboard-failure abort. */
  showError: (message: string) => Thenable<unknown>;
  /** Locate the Claude Code terminal to insert into. Trust a NAME match ONLY
   *  (host heuristic: a terminal named like "claude"); never the active
   *  terminal — sending the reference to an unrelated shell would both misfire
   *  and be mis-reported as success by the tier-1 truthy check below. No match
   *  → undefined → clipboard fallback (zero misfire). T is the host's Terminal
   *  type, kept generic so this module imports no vscode symbol. */
  findClaudeTerminal: () => T | undefined;
  /** terminal.sendText(text, false) bound — insert WITHOUT a trailing newline so
   *  the user reviews the reference before pressing Enter. */
  sendTerminalText: (terminal: T, text: string) => void;
  /** terminal.show() bound — surface the terminal after inserting. */
  showTerminal: (terminal: T) => void;
};

/** Build the `@`-mention reference. Matches the @-mention format Claude Code
 *  currently accepts (cross-checked against insertAtMention in extension.js
 *  v2.1.193):
 *    no selection      → `@${rel}`
 *    single line       → `@${rel}#L${line}`
 *    multi-line range  → `@${rel}#L${start}-${end}`. */
export function buildContextReference(
  relativePath: string,
  hasSelection: boolean,
  startLine: number,
  endLine: number
): string {
  if (!hasSelection) {
    return `@${relativePath}`;
  }
  return startLine === endLine
    ? `@${relativePath}#L${startLine}`
    : `@${relativePath}#L${startLine}-${endLine}`;
}

function clampLine(line: number, lineCount: number): number {
  if (!Number.isFinite(line)) {
    return 1;
  }
  return Math.min(Math.max(Math.trunc(line), 1), Math.max(lineCount, 1));
}

/** Swallow-and-report wrapper for a Thenable that resolves false on failure.
 *  Returns true only when the op resolved truthy; logs + returns false on a
 *  throw or a false resolution. */
async function tryBool(op: () => Thenable<boolean>, label: string): Promise<boolean> {
  try {
    return (await op()) === true;
  } catch (err) {
    console.error(`[quoll] context-handoff: ${label} failed`, err);
    return false;
  }
}

export async function handleContextHandoff<T>(
  payload: HandleContextHandoffPayload,
  deps: HandleContextHandoffDeps<T>
): Promise<void> {
  // Save first so the on-disk reference matches the lines the webview saw. The
  // @-mention is a disk reference; a dirty buffer would point Claude Code at
  // stale bytes. A FAILED save (false / throw) means the disk is still stale —
  // abort with a warning rather than hand off a misleading reference. (Note:
  // an edit typed within edit-sync's 300 ms debounce window may not yet be in
  // the TextDocument the save flushes — a documented v1 line-skew limitation,
  // not closed here.)
  if (deps.isDirty) {
    const saved = await tryBool(deps.save, "document.save()");
    if (!saved) {
      await tryShow(
        deps.showWarn,
        "Quoll: save this file to hand off accurate line references to Claude Code."
      );
      return;
    }
  }

  // Re-clamp + order the webview-supplied range against the live document,
  // reading lineCount AFTER the save so the bound matches the file the
  // @-mention resolves against (a save participant can change the line count).
  // The webview is the untrusted boundary; the validator already bounded the
  // numbers, but only the host knows the real line count.
  const lineCount = deps.getLineCount();
  const a = clampLine(payload.startLine, lineCount);
  const b = clampLine(payload.endLine, lineCount);
  const startLine = Math.min(a, b);
  const endLine = Math.max(a, b);

  const reference = buildContextReference(
    deps.relativePath,
    payload.hasSelection,
    startLine,
    endLine
  );

  // Tier 1 — direct insert. If a Claude Code terminal is found, drop the
  // reference into its input (no newline → the user confirms before Enter),
  // surface it, and SKIP the new-tab open commands. The clipboard write is now
  // only a paste safety net: the terminal already holds the text, so a clipboard
  // failure is non-fatal here (warn, don't abort) — unlike the fallback below.
  //
  // Tier-1 success is taken on a TRUTHY terminal, but findClaudeTerminal trusts
  // a NAME match only (never activeTerminal) — so a non-undefined terminal IS a
  // name-matched Claude terminal, never an arbitrary shell. The remaining
  // assumption is the name heuristic itself (a terminal literally named
  // "claude" might not be Claude Code); we accept that over sendText delivery
  // confirmation (no such VS Code API). A name miss → undefined → tier 2 below.
  const terminal = deps.findClaudeTerminal();
  if (terminal !== undefined) {
    deps.sendTerminalText(terminal, reference);
    deps.showTerminal(terminal);
    try {
      await deps.writeClipboard(reference);
    } catch (err) {
      console.warn("[quoll] context-handoff: clipboard insurance write failed", err);
    }
    // No success toast here: the reference is now visible in the surfaced
    // terminal's input line, so a notification would be redundant noise. (The
    // clipboard fallback path below DOES toast — nothing else signals the copy.)
    return;
  }

  // Tier 2 — clipboard fallback (no terminal found). The clipboard IS the
  // contract (what the user pastes). If it fails there is nothing to paste —
  // abort with an error, and do NOT open/focus Claude Code or claim success.
  try {
    await deps.writeClipboard(reference);
  } catch (err) {
    console.error("[quoll] context-handoff: clipboard write failed", err);
    await tryShow(
      deps.showError,
      "Quoll: couldn't copy the Claude Code reference to the clipboard."
    );
    return;
  }

  // Best-effort surface Claude Code. Each command independently guarded so a
  // missing install (command-not-found rejection) never blocks the others or
  // the success toast.
  for (const id of HANDOFF_OPEN_COMMANDS) {
    try {
      await deps.executeCommand(id);
    } catch (err) {
      console.warn("[quoll] context-handoff: command unavailable", { id, err });
    }
  }

  // Neutral wording — the chord is Cmd+Option+K (mac) / Ctrl+Alt+K (win+linux),
  // so the paste hint must not hard-code ⌘V.
  await tryShow(deps.showInfo, `Copied ${reference} — paste it into Claude Code.`);
}

/** Show a toast, swallowing a rejected Thenable (host detached / dispatcher
 *  torn down) so the handler never throws on a UI surface. */
async function tryShow(show: (m: string) => Thenable<unknown>, message: string): Promise<void> {
  try {
    await show(message);
  } catch (err) {
    console.error("[quoll] context-handoff: message surface rejected", err);
  }
}
