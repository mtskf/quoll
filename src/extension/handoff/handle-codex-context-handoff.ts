// Host-side handler for a webview "codex-context-handoff" request. Pure-function
// design (deps injected) so it unit-tests without a live VS Code host — mirrors
// handle-context-handoff.ts (the Claude path).
//
// Codex delivery differs fundamentally from Claude: it is a sidebar webview, not
// a terminal, and its only stable public command that accepts a document argument
// is `chatgpt.addFileToThread(uri)` — WHOLE-FILE only. The range-capable
// `chatgpt.addToThread` reads window.activeTextEditor and would require activating
// a raw text editor (a focus-stealing "second editor surface" the project's
// guardrails forbid). So Quoll hands Codex the whole file; line-range handoff is a
// documented product limitation of Codex's current public API, not a Quoll bug
// (see .claude/docs/SPEC.md). The host still owns the path: it passes THIS
// document's uri, never anything from the webview.
//
// COUPLING NOTE (future-proof): the command id below is the ONLY surface coupled
// to Codex. It is isolated here so a future upstream change is a one-file edit.
// The id is "what the Codex extension currently registers" (cross-checked against
// openai.chatgpt v26.623.70822 out/extension.js), NOT a published contract — treat
// the manual smoke + this comment as the canary.

import { makeHandoffGuards } from "./handoff-guards.js";

const { tryBool, tryShow } = makeHandoffGuards("codex-context-handoff");

/** The Codex command that adds a whole file (by Uri) to the active Codex thread
 *  and reveals its sidebar. Isolated so an upstream rename is a one-line edit. */
export const CODEX_ADD_FILE_COMMAND = "chatgpt.addFileToThread";

/** U is the host's Uri type, kept generic so this module imports no vscode
 *  symbol (matches handle-context-handoff.ts's generic-Terminal posture). */
export type HandleCodexContextHandoffDeps<U> = {
  /** document.uri — the whole-file reference Codex adds. Host-owned; the webview
   *  never sends a path. */
  documentUri: U;
  /** document.isDirty — gate the save. */
  isDirty: boolean;
  /** document.save() bound. Resolves false on failure. */
  save: () => Thenable<boolean>;
  /** commands.executeCommand bound (id + single Uri arg). */
  executeCommand: (id: string, arg: U) => Thenable<unknown>;
  /** window.showInformationMessage bound — success toast. */
  showInfo: (message: string) => Thenable<unknown>;
  /** window.showWarningMessage bound — save-failure / command-missing abort. */
  showWarn: (message: string) => Thenable<unknown>;
};

export async function handleCodexContextHandoff<U>(
  deps: HandleCodexContextHandoffDeps<U>
): Promise<void> {
  // Save first so Codex reads the file on disk, not stale bytes. A FAILED save
  // (false / throw) means the disk is still stale — abort with a warning that
  // names the FAILURE (not "just save it": the automatic save just failed, so
  // "save this file" would misdirect a read-only / permission error). Note:
  // document.save() flushes APPLIED edits; an edit typed within edit-sync's
  // ~300 ms debounce window may not yet be flushed — a documented LOW limitation
  // (no data loss; the edit still syncs on its own timer).
  if (deps.isDirty) {
    const saved = await tryBool(deps.save, "document.save()");
    if (!saved) {
      await tryShow(deps.showWarn, "Quoll: couldn't save this file, so it wasn't added to Codex.");
      return;
    }
  }

  // Whole-file handoff: addFileToThread takes the document Uri, adds the entire
  // file to the active Codex thread, and reveals the Codex sidebar. No line range
  // — Codex exposes no public Uri+range command (module header + SPEC). A rejection
  // (Codex not installed / command missing) aborts with a warning; we never claim
  // a success we did not achieve.
  try {
    await deps.executeCommand(CODEX_ADD_FILE_COMMAND, deps.documentUri);
  } catch (err) {
    console.error("[quoll] codex-context-handoff: addFileToThread failed", err);
    await tryShow(
      deps.showWarn,
      "Quoll: couldn't add this file to Codex — is the Codex extension installed?"
    );
    return;
  }

  // Concise, honest success toast: the user pressed the chord (possibly over a
  // selection) and Codex received the WHOLE file, so state that plainly.
  await tryShow(
    deps.showInfo,
    "Added this file to Codex (whole file — Codex doesn't support line-range handoff)."
  );
}
