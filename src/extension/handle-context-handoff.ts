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
//      (deps.findClaudeTerminal — name match OR a `claude` process in the
//      terminal's subtree, covering the CLI `/ide` case), send the reference
//      straight into its input WITHOUT a newline (the user reviews then presses
//      Enter), surface that terminal, and SKIP the panel commands. The clipboard
//      is still written as a paste safety net, but a failure there is non-fatal
//      (the terminal already has the text) — warn instead of aborting.
//   2. Clipboard fallback: if no terminal is found, copy the reference (a
//      clipboard failure here is fatal — there is nothing to paste). Then, ONLY
//      if a Claude Code panel is already open (deps.isClaudePanelOpen), focus it
//      (never OPEN a new one — that popped a rogue panel + threw "Webview is
//      disposed" for terminal users). Finally toast the user to paste.
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

/** Claude Code command that FOCUSES an already-open panel. Run ONLY when a
 *  Claude Code webview panel is present (see `isClaudePanelOpen`) so it focuses
 *  the existing panel instead of creating a new one. The old default also ran
 *  `claude-vscode.editor.open`, which popped an UNWANTED new panel (and threw
 *  "Webview is disposed" when Claude Code held a stale disposed panel) whenever
 *  no terminal was found — dropped in favour of the panel-gated focus below.
 *  Best-effort: a rejection is swallowed, so a missing Claude Code install never
 *  blocks the clipboard handoff. */
export const CLAUDE_FOCUS_COMMAND = "claude-vscode.focus";

/** The viewType of the Claude Code webview panel (`createWebviewPanel` in
 *  claude-code 2.1.199). QuollEditorPanel checks `window.tabGroups` for an open
 *  tab carrying this viewType before running CLAUDE_FOCUS_COMMAND, so Quoll
 *  never spawns a panel — it only focuses one the user already has open. */
export const CLAUDE_PANEL_VIEW_TYPE = "claudeVSCodePanel";

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
  /** Locate the Claude Code terminal to insert into. Proven-match ONLY (a
   *  terminal named like "claude", OR one whose shell-process subtree contains a
   *  `claude` executable — the CLI `/ide` case); never a bare active-terminal
   *  guess, which would misfire into an unrelated shell. No match → undefined →
   *  clipboard fallback (zero misfire). Async because the process pass awaits
   *  Terminal.processId + a `ps` read; a sync return is still accepted. T is the
   *  host's Terminal type, kept generic so this module imports no vscode symbol.
   *  See find-claude-terminal.ts. */
  findClaudeTerminal: () => T | undefined | PromiseLike<T | undefined>;
  /** terminal.sendText(text, false) bound — insert WITHOUT a trailing newline so
   *  the user reviews the reference before pressing Enter. */
  sendTerminalText: (terminal: T, text: string) => void;
  /** terminal.show() bound — surface the terminal after inserting. */
  showTerminal: (terminal: T) => void;
  /** True when a Claude Code webview panel (viewType CLAUDE_PANEL_VIEW_TYPE) is
   *  the ACTIVE (visible) tab of some tab group — the user is looking at it.
   *  Gates the tier-0 short-circuit so a visible panel wins the handoff over a
   *  background CLI terminal. */
  isClaudePanelVisible: () => boolean;
  /** True when a Claude Code webview panel is open in ANY tab (active or not).
   *  Gates the tier-2 focus so Quoll focuses an existing panel rather than
   *  spawning a new one. */
  isClaudePanelOpen: () => boolean;
};

/** Strip C0 control characters (U+0000–U+001F) and DEL (U+007F) from a path.
 *  A hostile POSIX filename can embed \n/\r; delivered via
 *  `terminal.sendText(text, false)` — which suppresses only the TRAILING
 *  newline — an embedded newline lands as Enter, so `@evil` ⏎ `rm -rf ~` ⏎
 *  would auto-execute (the clipboard tier carries the same poisoned bytes for a
 *  later paste). Stripping at reference-build time keeps neither delivery path
 *  able to carry an executable byte. Char-code filter (not a regex literal) so
 *  no control character is ever embedded in this source. Line numbers are
 *  numeric-clamped upstream, so `relativePath` is the only injection vector;
 *  codex-context-handoff passes a Uri, not text — unaffected. */
function stripControlChars(path: string): string {
  let out = "";
  for (const ch of path) {
    const code = ch.charCodeAt(0);
    if (code > 0x1f && code !== 0x7f) {
      out += ch;
    }
  }
  return out;
}

/** Build the `@`-mention reference. Matches the @-mention format Claude Code
 *  currently accepts (cross-checked against insertAtMention in extension.js
 *  v2.1.193):
 *    no selection      → `@${rel}`
 *    single line       → `@${rel}#L${line}`
 *    multi-line range  → `@${rel}#L${start}-${end}`.
 *  The path is stripped of C0/DEL control characters first — see
 *  stripControlChars for the terminal-injection rationale. */
export function buildContextReference(
  relativePath: string,
  hasSelection: boolean,
  startLine: number,
  endLine: number
): string {
  const rel = stripControlChars(relativePath);
  if (!hasSelection) {
    return `@${rel}`;
  }
  return startLine === endLine ? `@${rel}#L${startLine}` : `@${rel}#L${startLine}-${endLine}`;
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

  // Tier 0 — VISIBLE panel takes PRECEDENCE over the terminal. When the user is
  // looking at the Claude Code webview PANEL (its tab is the active tab of some
  // group), hand off to THAT: copy + focus it (there is no API to insert into a
  // foreign webview, so the user pastes). Without this, a background CLI terminal
  // — which panel users routinely keep running — would always win the handoff.
  // "Visible" = active tab of ANY group: the Quoll editor holds focus at chord
  // time so the panel is never in the *active group*; a panel merely PARKED in a
  // background tab is not displayed and correctly falls through to the terminal.
  // LIMITATION: only the editor-area panel is visible to tabGroups — a sidebar-
  // docked Claude Code (a WebviewView) is undetectable (no public API exposes a
  // foreign WebviewView's visibility) and also falls through to the terminal.
  if (deps.isClaudePanelVisible()) {
    if (!(await copyReferenceOrAbort(deps, reference))) {
      return;
    }
    await focusClaudePanel(deps);
    await tryShow(deps.showInfo, `Copied ${reference} — paste it into Claude Code.`);
    return;
  }

  // Tier 1 — direct insert. If a Claude Code terminal is found (name match OR a
  // `claude` process in the terminal's subtree — the CLI `/ide` case), drop the
  // reference into its input (no newline → the user confirms before Enter),
  // surface it, and SKIP the panel commands. The clipboard write is only a paste
  // safety net here: the terminal already holds the text, so a clipboard failure
  // is non-fatal (warn, don't abort) — unlike the fallback below. findClaudeTerminal
  // never returns an unproven terminal, so a non-undefined result IS a Claude
  // terminal, never an arbitrary shell (see find-claude-terminal.ts).
  const terminal = await deps.findClaudeTerminal();
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

  // Tier 2 — clipboard fallback (no visible panel, no terminal). The clipboard
  // IS the contract (what the user pastes); if it fails there is nothing to
  // paste — abort. Then focus an already-open (but not active) panel if one
  // exists — never OPEN a new one (the old `editor.open` default popped a rogue
  // panel + threw "Webview is disposed"). Finally toast the user to paste.
  if (!(await copyReferenceOrAbort(deps, reference))) {
    return;
  }
  if (deps.isClaudePanelOpen()) {
    await focusClaudePanel(deps);
  }
  // Neutral wording — the chord is Cmd+Option+K (mac) / Ctrl+Alt+K (win+linux),
  // so the paste hint must not hard-code ⌘V.
  await tryShow(deps.showInfo, `Copied ${reference} — paste it into Claude Code.`);
}

/** Write the reference to the clipboard. On failure show the error toast and
 *  return false so the caller aborts — a failed clipboard write means there is
 *  nothing for the user to paste. */
async function copyReferenceOrAbort<T>(
  deps: HandleContextHandoffDeps<T>,
  reference: string
): Promise<boolean> {
  try {
    await deps.writeClipboard(reference);
    return true;
  } catch (err) {
    console.error("[quoll] context-handoff: clipboard write failed", err);
    await tryShow(
      deps.showError,
      "Quoll: couldn't copy the Claude Code reference to the clipboard."
    );
    return false;
  }
}

/** Best-effort focus of an already-open Claude Code panel. `claude-vscode.focus`
 *  reveals/focuses the existing panel and is a no-op when it is already visible
 *  (it re-opens only when no webview is visible), so it never spawns a rogue
 *  panel. A rejection (missing install) is warned, never fatal. */
async function focusClaudePanel<T>(deps: HandleContextHandoffDeps<T>): Promise<void> {
  try {
    await deps.executeCommand(CLAUDE_FOCUS_COMMAND);
  } catch (err) {
    console.warn("[quoll] context-handoff: focus command unavailable", err);
  }
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
