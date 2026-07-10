// In-place editor-surface swap for ⌘⌥E (Quoll rich editor ↔ built-in text
// editor). vscode.openWith opens the TARGET as a second tab beside the source
// and never replaces it (E2E-probed 2026-07-10), so the source tab must be
// closed explicitly. Closing a DIRTY source tab reverts the shared working copy
// (CustomEditorInput.matches gap — memory quoll-custom-editor-close-reverts-shared-doc)
// and pops a save dialog, so we SAVE first (user-approved save-then-swap): a
// clean tab closes with no revert and no dialog. If the doc can't be made clean
// we DO NOT close (both-open, never data loss).

import { type Tab, TabInputCustom, TabInputText, type Uri, window, workspace } from "vscode";

/** Safety gate: close the source tab only when there is one AND the document is
 *  provably clean — either it was already clean, or it was dirty and the save
 *  succeeded and it is no longer dirty. Any other dirty state means the close
 *  would revert the shared working copy, so refuse (degrade to both-open). */
export function shouldCloseSourceTab(state: {
  hasSourceTab: boolean;
  wasDirty: boolean;
  saveSucceeded: boolean;
  stillDirtyAfterSave: boolean;
}): boolean {
  if (!state.hasSourceTab) {
    return false;
  }
  if (!state.wasDirty) {
    return true;
  }
  return state.saveSucceeded && !state.stillDirtyAfterSave;
}

/** The surface being switched AWAY from (its tab is the one to close). */
export type SourceSurface = "text" | "quoll";

function tabMatches(
  t: Tab,
  uriKey: string,
  surface: SourceSurface,
  quollViewType: string
): boolean {
  if (surface === "quoll") {
    return (
      t.input instanceof TabInputCustom &&
      t.input.viewType === quollViewType &&
      t.input.uri.toString() === uriKey
    );
  }
  return t.input instanceof TabInputText && t.input.uri.toString() === uriKey;
}

/** The source-surface tab for `uriKey`, preferring the ACTIVE tab (the surface
 *  the user toggled from). Fallback: only when EXACTLY ONE match exists across
 *  all groups — an ambiguous multi-split match returns undefined so the swap
 *  degrades to both-open rather than closing the wrong split (Codex #3). Capture
 *  this BEFORE opening the target surface. */
export function findSourceTab(
  uriKey: string,
  surface: SourceSurface,
  quollViewType: string
): Tab | undefined {
  const active = window.tabGroups.activeTabGroup.activeTab;
  if (active && tabMatches(active, uriKey, surface, quollViewType)) {
    return active;
  }
  const matches = window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => tabMatches(t, uriKey, surface, quollViewType));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Re-find a live tab matching `captured`'s identity (uri + surface kind, and
 *  viewType when it is a Quoll custom tab). `captured` may be a stale `Tab`
 *  object from an earlier tab-model snapshot — VS Code's Tab identity does not
 *  survive tab-model events, so this re-reads `window.tabGroups.all` fresh
 *  rather than trusting `captured` still resolves. Returns undefined if the
 *  tab is gone (e.g. the user closed it manually in between). */
function reresolveTab(captured: Tab): Tab | undefined {
  const uriKey =
    captured.input instanceof TabInputCustom
      ? captured.input.uri.toString()
      : captured.input instanceof TabInputText
        ? captured.input.uri.toString()
        : undefined;
  if (uriKey === undefined) {
    return undefined;
  }
  const surface: SourceSurface = captured.input instanceof TabInputCustom ? "quoll" : "text";
  const quollViewType = captured.input instanceof TabInputCustom ? captured.input.viewType : "";
  return window.tabGroups.all
    .flatMap((g) => g.tabs)
    .find((t) => tabMatches(t, uriKey, surface, quollViewType));
}

/** Finalize an in-place swap: the caller has already opened the TARGET surface.
 *  Save the shared doc if dirty (so the source tab is clean and closing it can
 *  neither revert the working copy nor pop a save dialog), then close the
 *  pre-captured source tab. Refuses to close if the doc can't be made clean
 *  (never data loss). Best-effort; never throws. */
export async function finalizeSurfaceSwap(uri: Uri, sourceTab: Tab | undefined): Promise<void> {
  try {
    const doc = await workspace.openTextDocument(uri);
    const wasDirty = doc.isDirty;
    let saveSucceeded = false;
    // Only save a dirty FILE-scheme doc. A non-file/untitled doc's save() can
    // pop a Save As modal (Codex #4) — Quoll only opens file docs (canEditWith),
    // so this is defence-in-depth: a dirty non-file doc is treated as
    // not-saveable → not closed → both-open.
    if (wasDirty && uri.scheme === "file") {
      try {
        saveSucceeded = await doc.save();
      } catch (err) {
        console.error("[quoll] surface-swap: save before close failed", err);
        saveSucceeded = false;
      }
    }
    const allow = shouldCloseSourceTab({
      hasSourceTab: sourceTab !== undefined,
      wasDirty,
      saveSucceeded,
      stillDirtyAfterSave: doc.isDirty,
    });
    if (!allow) {
      if (doc.isDirty) {
        // Surface a warning so the user understands why both editors remain
        // (a silent no-op reads as a dead keybinding) — error-handler Conf 85.
        console.warn(
          "[quoll] surface-swap: document still dirty; leaving both surfaces open to avoid a revert"
        );
        void window
          .showWarningMessage(
            "Quoll: couldn't save the document, so both editors stay open. Save manually, then try again."
          )
          .then(undefined, (e: unknown) => console.error("[quoll] showWarningMessage rejected", e));
      }
      return;
    }
    // sourceTab is defined here (shouldCloseSourceTab is false when it is not).
    // Re-resolve a LIVE tab for the same identity right before closing: Tab
    // object identity is not stable across tab-model events (the target
    // surface opening in between IS such an event — same fact already
    // documented for the reveal-for-mention cleanup in
    // reveal-for-mention-cleanup.ts), so closing the tab captured earlier by
    // findSourceTab can throw "Invalid tab not found" even though the tab it
    // refers to (by uri) is still open.
    const liveSourceTab = sourceTab && reresolveTab(sourceTab);
    const closed = liveSourceTab ? await window.tabGroups.close(liveSourceTab, true) : true;
    if (!closed) {
      console.warn("[quoll] surface-swap: source tab close was cancelled; both surfaces remain");
    }
  } catch (err) {
    console.error("[quoll] finalizeSurfaceSwap failed", err);
  }
}
