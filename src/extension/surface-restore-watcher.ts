// Enforcement half of session-only editor-surface memory (the store lives in
// surface-memory.ts). A single window.tabGroups.onDidChangeTabs watcher reacts
// to newly OPENED `.md` tabs and, when a default text open disagrees with a
// remembered Quoll surface, reopens it in Quoll.
//
// Why the Tabs API (not onDidOpenTextDocument): Quoll is a CustomTextEditor, so
// it opens the backing TextDocument too — onDidOpenTextDocument cannot tell the
// two surfaces apart. The Tabs API separates TabInputCustom (Quoll) from
// TabInputText (built-in) cleanly. This is the only onDidChangeTabs listener FOR
// SURFACE MEMORY; it coexists with the per-panel revert-rescue listener
// (quoll-editor-panel.ts, watches e.closed — a separate concern). We read only
// e.opened.
//
// Restore is ASYMMETRIC (upgrade-to-Quoll only). Quoll's custom-editor priority
// is "option", so VS Code never opens Quoll by default — a Quoll tab opening is
// always intentional and is adopted, never bounced. Only a default text open is
// ever reopened, into a remembered Quoll surface (decideOpenReconcile). The
// flash is inherent (no pre-open veto for custom editors); we react synchronously
// in the opened handler to minimise the visible double-open.
//
// Restore is PASSIVE (triggered by merely opening a file), which shapes three
// deliberate choices:
//   - It NEVER forces a save: planRestore skips a dirty doc, and the source tab
//     is closed via closeSourceTabIfClean (no doc.save()). A dirty doc is left
//     in whatever surface VS Code opened it in.
//   - It fails QUIETLY (console.error, no toast): the three user-initiated
//     switch sites toast because a silent failure reads as a dead control, but a
//     passive open-triggered restore has no pending user action, so a toast
//     would be noise — the file is already in a valid surface.
//   - A readonly / non-file doc remembered as Quoll is left in the text editor
//     WITHOUT recording (canEditWith gate → planRestore "skip"): the Quoll
//     preference is deliberately preserved so it restores if the doc later
//     becomes writable. The per-open recheck is a cheap canEditWith
//     short-circuit, not a hot loop.

import {
  type Disposable,
  type Tab,
  TabInputCustom,
  TabInputText,
  type Uri,
  window,
  workspace,
} from "vscode";
import { canEditWith } from "./can-edit-with.js";
import { openInQuollEditor } from "./open-in-quoll.js";
import { openInTextEditor } from "./reopen-text-editor.js";
import { type EditorSurface, reconcileOpen } from "./surface-memory.js";
import { closeSourceTabIfClean } from "./surface-swap.js";

function isMarkdownUri(uri: { path: string }): boolean {
  return uri.path.toLowerCase().endsWith(".md");
}

/** Classify a tab input as a `.md` editor surface, or null. Pure over the input
 *  so the classification is unit-testable without a live tab model. A Quoll
 *  custom tab (matching viewType) → "quoll"; a markdown text tab → "text". */
export function classifyOpenedTab(
  input: unknown,
  quollViewType: string
): { surface: EditorSurface; uri: Uri } | null {
  if (input instanceof TabInputCustom && input.viewType === quollViewType) {
    return isMarkdownUri(input.uri) ? { surface: "quoll", uri: input.uri } : null;
  }
  if (input instanceof TabInputText) {
    return isMarkdownUri(input.uri) ? { surface: "text", uri: input.uri } : null;
  }
  return null;
}

export type RestoreAction = "reopen-quoll" | "reopen-text" | "skip";

/** Pure restore-action decision. `target` is the remembered surface to restore
 *  to; `isDirty` is the shared doc's dirty flag; `canOpenQuoll` is whether Quoll
 *  may edit the doc (canEditWith). Skip on a dirty doc (passive restore never
 *  saves) or a non-editable Quoll target (readonly/non-file). */
export function planRestore(
  target: EditorSurface,
  isDirty: boolean,
  canOpenQuoll: boolean
): RestoreAction {
  if (isDirty) {
    return "skip";
  }
  if (target === "quoll") {
    return canOpenQuoll ? "reopen-quoll" : "skip";
  }
  return "reopen-text";
}

/** True iff the same doc is already open in the OTHER surface — the signal of a
 *  deliberate side-by-side / mid-swap rather than a fresh reopen. Reuses
 *  classifyOpenedTab so surface/uri matching stays in one place. */
function hasSiblingInOtherSurface(uri: Uri, shown: EditorSurface, quollViewType: string): boolean {
  const uriKey = uri.toString();
  return window.tabGroups.all
    .flatMap((g) => g.tabs)
    .some((t) => {
      const c = classifyOpenedTab(t.input, quollViewType);
      return c !== null && c.uri.toString() === uriKey && c.surface !== shown;
    });
}

/** Reopen `uri` in `target` and close the just-opened (wrong-surface) source tab
 *  via closeSourceTabIfClean (no save). planRestore gates the dirty / readonly
 *  cases. Best-effort; never throws — a passive restore failure logs only and
 *  leaves the doc in the (valid) surface VS Code opened it in. */
async function restoreSurface(
  target: EditorSurface,
  uri: Uri,
  sourceTab: Tab,
  quollViewType: string
): Promise<void> {
  try {
    const doc = await workspace.openTextDocument(uri);
    const canOpenQuoll = canEditWith(doc, (scheme) =>
      workspace.fs.isWritableFileSystem(scheme)
    ).ok;
    const action = planRestore(target, doc.isDirty, canOpenQuoll);
    if (action === "skip") {
      return;
    }
    if (action === "reopen-quoll") {
      await openInQuollEditor(uri, quollViewType);
    } else {
      await openInTextEditor(uri);
    }
    await closeSourceTabIfClean(uri, sourceTab);
  } catch (err) {
    console.error("[quoll] surface restore failed", err);
  }
}

/** Register the surface-restore watcher. For every newly OPENED `.md` tab, ask
 *  the in-memory store to reconcile: adopt the shown surface, or (asymmetric)
 *  upgrade a default text open into a remembered Quoll surface. A per-URI
 *  in-flight `Set` suppresses overlapping restores of the same URI
 *  (restoreSurface is fire-and-forget; several opened events for one URI can
 *  arrive close together). `quollViewType` is QuollEditorPanel.viewType (passed
 *  in so this module need not import the heavy panel module). Disposed on
 *  deactivate. */
export function registerSurfaceRestoreWatcher(quollViewType: string): Disposable {
  const restoring = new Set<string>();
  return window.tabGroups.onDidChangeTabs((e) => {
    for (const tab of e.opened) {
      const classified = classifyOpenedTab(tab.input, quollViewType);
      if (classified === null) {
        continue;
      }
      const { surface, uri } = classified;
      const uriKey = uri.toString();
      // A restore for this URI is already running — its own reopen fires an
      // opened event we must NOT re-process (memory already holds the target).
      if (restoring.has(uriKey)) {
        continue;
      }
      const hasSibling = hasSiblingInOtherSurface(uri, surface, quollViewType);
      const reopen = reconcileOpen(uriKey, surface, hasSibling);
      if (reopen === null) {
        continue;
      }
      restoring.add(uriKey);
      void restoreSurface(reopen, uri, tab, quollViewType).finally(() =>
        restoring.delete(uriKey)
      );
    }
  });
}
