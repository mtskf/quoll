// Host-side handler for a webview "context-handoff" request. Pure-function
// design (deps injected) so it unit-tests without a live VS Code host —
// mirrors handle-open-external.ts.
//
// The host is the canonical document owner: it builds the reference from its
// OWN document.uri (via workspace.asRelativePath, supplied as deps.relativePath)
// and re-clamps the webview-supplied line numbers to the live document's line
// count. The webview sends only selection geometry; it never sends a path.
//
// Handoff mechanism (v3, delegation-first) — after the save gate + clamp:
//
//   Tier 0 — delegate to Claude Code's own `claude-code.insertAtMentioned`
//   command. The command takes NO arguments: it reads window.activeTextEditor
//   and builds the @-mention from that editor's document + selection, then
//   routes it to wherever the user's Claude Code actually lives — a VISIBLE
//   Claude Code webview (sidebar OR panel) gets the mention inserted straight
//   into its composer (a panel also gets reveal()); otherwise it is pushed as
//   `at_mentioned {filePath, lineStart, lineEnd}` over the extension's
//   localhost MCP WebSocket to the most-recently-connected CLI `/ide` session
//   (verified against claude-code 2.1.199). Because activeTextEditor only ever
//   points at a VISIBLE text editor, deps.revealForMention first shows this
//   document as a text editor (reusing an already-visible one, else opening a
//   second tab IN PLACE — ViewColumn.Active, the Quoll tab's own group, no
//   layout shift) with preserveFocus:false + the payload's selection, and
//   resolves to a cleanup that closes only the tab(s) the reveal opened
//   (closing the temp tab re-activates the Quoll tab, so focus returns).
//   preserveFocus:false is load-bearing: preserveFocus:true never sets
//   activeTextEditor at all (probe-verified in a real host — see
//   test/extension/e2e/reveal-for-mention-platform.test.ts), which made the
//   delegation silently no-op. After the reveal and BEFORE the command,
//   deps.isDocumentActiveTextEditor gates the delegation — if the reveal did
//   not actually make this document the activeTextEditor, the handler warns
//   and drops to the fallback tier instead of firing a command that would
//   silently do nothing.
//
//   An earlier iteration REJECTED exactly this reveal-then-delegate path over
//   the brief raw-markdown flash of the temporary text editor; that decision
//   has been REVERSED by an explicit product decision — auto-insert parity
//   with native text editors (the mention lands in the composer with zero
//   keystrokes) outweighs the flash.
//
//   On success the reference is ALSO written to the clipboard as silent
//   insurance (non-fatal — warn only): Claude Code's routing has a silent-drop
//   limitation — when NEITHER a visible Claude webview NOR a connected CLI
//   session exists, the delegated mention is dropped with no surface at all,
//   and the clipboard is then the only thing that saves the user. No success
//   toast: when delivery succeeds the mention visibly lands in the composer /
//   CLI prompt, so a notification would be redundant noise.
//
//   Fallback tier (v1, unchanged): if the delegation command is unavailable
//   (Claude Code missing or too old → executeCommand rejects) or the reveal
//   itself fails, copy the reference to the clipboard (a failure here IS fatal
//   — there is nothing to paste), best-effort open+focus Claude Code, then
//   toast the user to paste.
//
// The v2 terminal tier (name-matched terminal.sendText) is REMOVED: the
// delegation already reaches the CLI via Claude Code's own at_mentioned
// channel, which targets the actually-connected `/ide` session rather than
// whatever terminal happens to be named "claude" — strictly more accurate
// than the name heuristic. Keeping both would double-deliver the reference.
//
// COUPLING NOTE (future-proof): the `claude-code.insertAtMentioned` command id
// below is the coupling surface to Claude Code (plus the best-effort
// open-command ids). It is an UNDOCUMENTED zero-arg command of a
// weekly-shipping minified bundle, not a published contract (verified against
// claude-code 2.1.199); if a future release renames or drops it,
// executeCommand rejects and the clipboard fallback keeps working — the
// fallback tier is the safety net, and this comment + the manual smoke are
// the canary.

/** Claude Code's own zero-arg insert command (tier 0). Reads
 *  window.activeTextEditor + its selection, builds the @-mention, and routes
 *  it to the visible Claude Code webview, else to the connected CLI `/ide`
 *  session (verified against claude-code 2.1.199). Rejection (command not
 *  found) drives the clipboard fallback tier. */
export const CLAUDE_INSERT_AT_MENTIONED_COMMAND = "claude-code.insertAtMentioned";

/** Claude Code commands tried, in order, to surface its input for a paste on
 *  the FALLBACK tier. Best-effort: each is executed independently and its
 *  rejection swallowed, so a missing Claude Code install never blocks the
 *  clipboard handoff. */
export const HANDOFF_OPEN_COMMANDS = ["claude-vscode.editor.open", "claude-vscode.focus"] as const;

export type HandleContextHandoffPayload = {
  hasSelection: boolean;
  startLine: number;
  endLine: number;
};

/** Selection geometry handed to deps.revealForMention. Lines are 1-based and
 *  already clamped to the live document + ordered (startLine <= endLine) by
 *  handleContextHandoff, so the implementation can index lines directly. */
export type HandoffRevealSelection = {
  hasSelection: boolean;
  startLine: number;
  endLine: number;
};

export type HandleContextHandoffDeps = {
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
  /** window.showInformationMessage bound — fallback-tier paste toast. */
  showInfo: (message: string) => Thenable<unknown>;
  /** window.showWarningMessage bound — save-failure abort. */
  showWarn: (message: string) => Thenable<unknown>;
  /** window.showErrorMessage bound — fallback clipboard-failure abort. */
  showError: (message: string) => Thenable<unknown>;
  /** Tier-0 reveal: show THIS document as the ACTIVE text editor carrying the
   *  given selection (focus moves to it for the flash duration and returns
   *  when the cleanup's tab close re-activates the Quoll tab), so Claude
   *  Code's zero-arg insert command (which reads window.activeTextEditor)
   *  sees the right document + range. Resolves to a cleanup that closes only
   *  the tab(s) the reveal opened (a no-op when an existing tab was reused);
   *  may reject (→ fallback tier). Implemented by QuollEditorPanel, which
   *  owns `document` and `window` — this module stays vscode-import-free. */
  revealForMention: (selection: HandoffRevealSelection) => Thenable<() => Thenable<void>>;
  /** Pre-command guard: true when window.activeTextEditor currently shows
   *  THIS document. Claude Code's insert command silently no-ops when
   *  activeTextEditor is absent or points elsewhere — a failure the host
   *  cannot observe after the fact (the command resolves either way).
   *  Checking BEFORE the command converts that silent-failure class into a
   *  detectable one that falls back to the clipboard tier. Probe-verified
   *  that a preserveFocus:false reveal sets activeTextEditor synchronously by
   *  reveal resolution, so a sync check here is reliable. */
  isDocumentActiveTextEditor: () => boolean;
};

/** Strip C0 control characters (U+0000–U+001F) and DEL (U+007F) from a path.
 *  A hostile POSIX filename can embed \n/\r; the reference reaches the
 *  clipboard on BOTH tiers (insurance write + fallback copy), and a later
 *  paste into the Claude Code CLI terminal delivers an embedded newline as
 *  Enter — so `@evil` ⏎ `rm -rf ~` ⏎ would auto-execute. Stripping at
 *  reference-build time keeps the delivered reference unable to carry an
 *  executable byte. Char-code filter (not a regex literal) so no control
 *  character is ever embedded in this source. Line numbers are
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

/** Build the `@`-mention reference for the insurance write + fallback tier.
 *  Matches the @-mention format Claude Code currently accepts (cross-checked
 *  against insertAtMentioned in extension.js v2.1.199):
 *    no selection      → `@${rel}`
 *    single line       → `@${rel}#L${line}`
 *    multi-line range  → `@${rel}#L${start}-${end}`.
 *  The path is stripped of C0/DEL control characters first — see
 *  stripControlChars for the paste-injection rationale. */
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

/** Tier 0 — reveal the document (activeTextEditor choreography) and delegate
 *  to Claude Code's own insert command. Returns true only when the command
 *  resolved (Claude Code accepted the delegation). Between the reveal and the
 *  command, the activeTextEditor guard verifies the reveal actually took —
 *  the command silently no-ops on a wrong/absent activeTextEditor, so a
 *  failed guard resolves false (→ fallback tier) rather than firing a
 *  command whose failure the host could never observe. The cleanup ALWAYS
 *  runs (finally) — including when the guard fails or the command rejects —
 *  and its own failure is swallowed (warn) so it can neither mask a
 *  delegation success nor convert one into a spurious fallback. A reveal
 *  rejection or a command rejection (Claude Code missing / too old) resolves
 *  false → fallback tier. */
async function tryDelegateToClaudeCode(
  selection: HandoffRevealSelection,
  deps: HandleContextHandoffDeps
): Promise<boolean> {
  let cleanup: (() => Thenable<void>) | undefined;
  try {
    cleanup = await deps.revealForMention(selection);
    if (!deps.isDocumentActiveTextEditor()) {
      console.warn(
        "[quoll] context-handoff: reveal did not make the document the active text editor; " +
          "skipping insertAtMentioned and falling back"
      );
      return false;
    }
    await deps.executeCommand(CLAUDE_INSERT_AT_MENTIONED_COMMAND);
    return true;
  } catch (err) {
    console.warn("[quoll] context-handoff: delegation to Claude Code failed; falling back", err);
    return false;
  } finally {
    if (cleanup !== undefined) {
      try {
        await cleanup();
      } catch (err) {
        console.warn("[quoll] context-handoff: temporary editor cleanup failed", err);
      }
    }
  }
}

export async function handleContextHandoff(
  payload: HandleContextHandoffPayload,
  deps: HandleContextHandoffDeps
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
  // numbers, but only the host knows the real line count. revealForMention
  // relies on this clamp to index lines directly (no await sits between the
  // clamp and the reveal call, so the document cannot shrink in between).
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

  // Tier 0 — delegation. On success Claude Code has already delivered the
  // mention (visible composer, else connected CLI session), so the clipboard
  // write is only silent insurance against the silent-drop case (neither
  // surface exists) — non-fatal, warn only, and NO toast (the mention landing
  // is its own signal; the drop case has no host-observable failure to key a
  // toast on).
  const delegated = await tryDelegateToClaudeCode(
    { hasSelection: payload.hasSelection, startLine, endLine },
    deps
  );
  if (delegated) {
    try {
      await deps.writeClipboard(reference);
    } catch (err) {
      console.warn("[quoll] context-handoff: clipboard insurance write failed", err);
    }
    return;
  }

  // Fallback tier — clipboard handoff (v1, verbatim). The clipboard IS the
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
