// In-place editor-surface swap for ⌘⌥E (Quoll rich editor ↔ built-in text
// editor). vscode.openWith opens the TARGET as a second tab beside the source
// and never replaces it (E2E-probed 2026-07-10), so the source tab must be
// closed explicitly. Closing a DIRTY source tab reverts the shared working copy
// (CustomEditorInput.matches gap — memory quoll-custom-editor-close-reverts-shared-doc)
// and pops a save dialog, so we SAVE first (user-approved save-then-swap): a
// clean tab closes with no revert and no dialog. If the doc can't be made clean
// we DO NOT close (both-open, never data loss).

import {
  type Tab,
  TabInputCustom,
  TabInputText,
  type TextDocument,
  type Uri,
  window,
  workspace,
} from "vscode";

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

/** Re-find a live tab matching `captured`'s identity. `captured` may be a stale
 *  `Tab` object from an earlier tab-model snapshot — VS Code's Tab identity does
 *  not survive tab-model events (the target surface opening in between IS such an
 *  event), so this re-reads the tab model fresh rather than trusting `captured`
 *  still resolves.
 *
 *  Re-resolution is scoped to the captured tab's OWN group (keyed by the stable
 *  `viewColumn`), NOT a first-match sweep across all groups: with the same file
 *  open as text in multiple splits, an all-groups `.find` can return a DIFFERENT
 *  split's tab and close the wrong one (the source tab then stays open — both
 *  surfaces visible in the group the user toggled from). If the tab is gone from
 *  its group, refuse (return undefined) rather than fall back to another split. */
function reresolveTab(captured: Tab): Tab | undefined {
  // Classify the captured tab once (custom vs text); anything else is not a swap
  // source and cannot be re-resolved.
  let uriKey: string;
  let surface: SourceSurface;
  let quollViewType: string;
  if (captured.input instanceof TabInputCustom) {
    uriKey = captured.input.uri.toString();
    surface = "quoll";
    quollViewType = captured.input.viewType;
  } else if (captured.input instanceof TabInputText) {
    uriKey = captured.input.uri.toString();
    surface = "text";
    quollViewType = "";
  } else {
    return undefined;
  }
  // Scope to the captured tab's own group by COLUMN, then find the tab there.
  // `captured` is a stale snapshot Tab after the intervening open; its `.group`
  // wrapper is NOT retained in `window.tabGroups.all` (a reference/`includes`
  // check rejects every swap — verified empirically on VS Code 1.94.0), so we
  // read the source group's `viewColumn` off it and re-find the LIVE group at
  // that column. This closes the correct split for the real cases (single view,
  // and multi-split toggled from any group — pinned by the E2E). Accepted narrow
  // gap: if the source group is itself destroyed mid-swap AND an unrelated
  // same-file text split is compacted into its old column slot, this could match
  // that split's tab — reachable only by closing the entire source split within
  // the sub-ms open window, and the stable Tabs API exposes no group identity to
  // disambiguate it.
  const capturedColumn = captured.group.viewColumn;
  const group = window.tabGroups.all.find((g) => g.viewColumn === capturedColumn);
  return group?.tabs.find((t) => tabMatches(t, uriKey, surface, quollViewType));
}

/** Injectable IO seam for `finalizeSurfaceSwap`. Production wires the real VS
 *  Code surfaces (`REAL_SWAP_DEPS`); unit tests inject fakes to exercise the
 *  save-failure and tab-gone / cancelled-close arms without a live tab model. */
export interface FinalizeSwapDeps {
  openDoc: (uri: Uri) => Thenable<TextDocument>;
  reresolveSourceTab: (tab: Tab) => Tab | undefined;
  closeTab: (tab: Tab) => Thenable<boolean>;
}

const REAL_SWAP_DEPS: FinalizeSwapDeps = {
  openDoc: (uri) => workspace.openTextDocument(uri),
  reresolveSourceTab: reresolveTab,
  closeTab: (tab) => window.tabGroups.close(tab, true),
};

/** Finalize an in-place swap: the caller has already opened the TARGET surface.
 *  Save the shared doc if dirty (so the source tab is clean and closing it can
 *  neither revert the working copy nor pop a save dialog), then close the
 *  pre-captured source tab. Refuses to close if the doc can't be made clean
 *  (never data loss). Best-effort; never throws. `deps` is seamed for tests. */
export async function finalizeSurfaceSwap(
  uri: Uri,
  sourceTab: Tab | undefined,
  deps: FinalizeSwapDeps = REAL_SWAP_DEPS
): Promise<void> {
  try {
    const doc = await deps.openDoc(uri);
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
    // object identity is not stable across tab-model events (the target surface
    // opening in between IS such an event), so closing the tab captured earlier
    // by findSourceTab can throw "Invalid tab not found" even though the tab it
    // refers to (by uri, in its group) is still open. reresolveTab returns
    // undefined if the tab is gone → nothing to close (both-open, safe).
    const liveSourceTab = sourceTab && deps.reresolveSourceTab(sourceTab);
    const closed = liveSourceTab ? await deps.closeTab(liveSourceTab) : true;
    if (!closed) {
      console.warn("[quoll] surface-swap: source tab close was cancelled; both surfaces remain");
    }
  } catch (err) {
    console.error("[quoll] finalizeSurfaceSwap failed", err);
  }
}

/** Close the pre-captured `sourceTab` ONLY if the shared doc is currently clean.
 *  Unlike finalizeSurfaceSwap this NEVER saves — it is the PASSIVE-restore
 *  finalizer (surface-restore-watcher.ts): a restore is triggered by merely
 *  opening a file, so it must not write the user's disk. A dirty doc ⇒ leave the
 *  tab open (both surfaces remain; a later clean open restores). Re-resolves a
 *  live tab for the same identity before closing (Tab identity is not stable
 *  across tab-model events). Best-effort; never throws. `deps` is seamed for
 *  tests. */
export async function closeSourceTabIfClean(
  uri: Uri,
  sourceTab: Tab | undefined,
  deps: FinalizeSwapDeps = REAL_SWAP_DEPS
): Promise<void> {
  if (sourceTab === undefined) {
    return;
  }
  try {
    const doc = await deps.openDoc(uri);
    if (doc.isDirty) {
      console.warn("[quoll] surface restore: doc is dirty; leaving both surfaces open");
      return;
    }
    const liveSourceTab = deps.reresolveSourceTab(sourceTab);
    const closed = liveSourceTab ? await deps.closeTab(liveSourceTab) : true;
    if (!closed) {
      console.warn("[quoll] surface restore: source tab close was cancelled; both surfaces remain");
    }
  } catch (err) {
    console.error("[quoll] closeSourceTabIfClean failed", err);
  }
}
