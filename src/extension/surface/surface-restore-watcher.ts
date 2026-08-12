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
  type TextDocument,
  type Uri,
  window,
  workspace,
} from "vscode";
import type { IsWritableFileSystem } from "../file-system.js";
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

/** True iff `tabInputs` contains a tab for `uriKey` in a surface OTHER than
 *  `shown` — the signal of a deliberate side-by-side / mid-swap rather than a
 *  fresh reopen. Pure over the tab-input list (the caller passes the live tab
 *  model) so it is unit-testable; reuses classifyOpenedTab so surface/uri
 *  matching stays in one place. */
export function hasSiblingInOtherSurface(
  tabInputs: readonly unknown[],
  uriKey: string,
  shown: EditorSurface,
  quollViewType: string
): boolean {
  return tabInputs.some((input) => {
    const c = classifyOpenedTab(input, quollViewType);
    return c !== null && c.uri.toString() === uriKey && c.surface !== shown;
  });
}

/** The `.input` of every open tab across all groups — the live tab model the
 *  sibling check reads. */
function allOpenTabInputs(): unknown[] {
  return window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.input);
}

/** Injectable IO seam for `restoreSurface`. Production wires the real VS Code /
 *  sibling-module surfaces (`REAL_RESTORE_DEPS`); unit tests inject fakes to
 *  exercise the ORDER of the reopen→close pair and the skip / failure arms
 *  without a live tab model. Mirrors `FinalizeSwapDeps` in surface-swap.ts —
 *  same shape (exported interface + module-private real bindings + trailing
 *  defaulted parameter) so the two surface finalizers stay one pattern.
 *
 *  `isWritableFileSystem` (not a whole `canEditWith`) is the seam: the decision
 *  itself is the already-tested pure `canEditWith`, so only its one impure input
 *  is injected — the readonly SKIP arm stays a real `canEditWith` call. */
export interface RestoreDeps {
  openDoc: (uri: Uri) => Thenable<TextDocument>;
  isWritableFileSystem: IsWritableFileSystem;
  openInQuoll: (uri: Uri, quollViewType: string) => Thenable<unknown>;
  openInText: (uri: Uri) => Thenable<unknown>;
  closeSourceTab: (uri: Uri, sourceTab: Tab) => Thenable<void>;
}

const REAL_RESTORE_DEPS: RestoreDeps = {
  openDoc: (uri) => workspace.openTextDocument(uri),
  isWritableFileSystem: (scheme) => workspace.fs.isWritableFileSystem(scheme),
  openInQuoll: openInQuollEditor,
  openInText: openInTextEditor,
  closeSourceTab: closeSourceTabIfClean,
};

/** Reopen `uri` in `target` and close the just-opened (wrong-surface) source tab
 *  via closeSourceTabIfClean (no save). planRestore gates the dirty / readonly
 *  cases. Best-effort; never throws — a passive restore failure logs only and
 *  leaves the doc in the (valid) surface VS Code opened it in. `deps` is seamed
 *  for tests (see RestoreDeps); production passes the real bindings.
 *
 *  ORDER IS LOAD-BEARING: the target surface is opened and AWAITED before the
 *  source tab is closed. Closing first would leave a window with no editor for
 *  the doc, and a reopen failure would then have closed the only surface the
 *  user had. */
export async function restoreSurface(
  target: EditorSurface,
  uri: Uri,
  sourceTab: Tab,
  quollViewType: string,
  deps: RestoreDeps = REAL_RESTORE_DEPS
): Promise<void> {
  try {
    const doc = await deps.openDoc(uri);
    const canOpenQuoll = canEditWith(doc, deps.isWritableFileSystem).ok;
    const action = planRestore(target, doc.isDirty, canOpenQuoll);
    if (action === "skip") {
      return;
    }
    if (action === "reopen-quoll") {
      await deps.openInQuoll(uri, quollViewType);
    } else {
      await deps.openInText(uri);
    }
    await deps.closeSourceTab(uri, sourceTab);
  } catch (err) {
    // This log is the only diagnostic channel for THIS function's failures —
    // the feature is deliberately silent (no toast) — so it carries the
    // identifying context: without the uri and the target surface an openDoc
    // rejection and a reopen rejection collapse into one indistinguishable
    // line. (The finalizer it delegates to, closeSourceTabIfClean, logs its own
    // warnings separately; they never route through this catch.)
    console.error("[quoll] surface restore failed", { uri: uri.toString(), target, err });
  }
}

/** Register the surface-restore watcher. For every newly OPENED `.md` tab, ask
 *  the in-memory store to reconcile: adopt the shown surface, or (asymmetric)
 *  upgrade a default text open into a remembered Quoll surface. A per-URI
 *  in-flight `Set` suppresses overlapping restores of the same URI
 *  (restoreSurface is fire-and-forget; several opened events for one URI can
 *  arrive close together). `quollViewType` is QuollEditorPanel.viewType (passed
 *  in so this module need not import the heavy panel module). Disposed on
 *  deactivate. `deps` is seamed for tests and forwarded verbatim to
 *  restoreSurface. */
export function registerSurfaceRestoreWatcher(
  quollViewType: string,
  deps: RestoreDeps = REAL_RESTORE_DEPS
): Disposable {
  const restoring = new Set<string>();
  return window.tabGroups.onDidChangeTabs((e) => {
    for (const tab of e.opened) {
      const classified = classifyOpenedTab(tab.input, quollViewType);
      if (classified === null) {
        continue;
      }
      const { surface, uri } = classified;
      const uriKey = uri.toString();
      // A restore for this URI is already running. The hazard is NOT the
      // restore's own reopen — that arrives as a Quoll (custom) open, which
      // decideOpenReconcile always adopts (reopen: null), so it could never
      // start a second restore. It is a DUPLICATE TEXT open landing mid-restore,
      // and which harm it does depends on how far the restore has got: before
      // the Quoll tab exists it re-enters decideOpenReconcile's upgrade branch
      // and starts a redundant second restore; once the Quoll tab IS live the
      // sibling makes reconcileOpen record "text" instead, silently overwriting
      // the remembered "quoll" we are in the middle of restoring to.
      if (restoring.has(uriKey)) {
        continue;
      }
      const hasSibling = hasSiblingInOtherSurface(
        allOpenTabInputs(),
        uriKey,
        surface,
        quollViewType
      );
      const reopen = reconcileOpen(uriKey, surface, hasSibling);
      if (reopen === null) {
        continue;
      }
      // Accepted boundary: the guard is released ONLY on settlement. A
      // `deps.openDoc` (workspace.openTextDocument) that never settles — an
      // unresponsive FileSystemProvider — leaves `uriKey` held for the session,
      // silently disabling restore for that one URI (no throw ⇒ no catch ⇒ no
      // log). Deliberate: a timer-based release could fire a second reopen while
      // the first is still pending, and the degradation is "the file stays in
      // the valid surface VS Code opened it in", the same end state as any other
      // restore failure.
      restoring.add(uriKey);
      void restoreSurface(reopen, uri, tab, quollViewType, deps).finally(() =>
        restoring.delete(uriKey)
      );
    }
  });
}
