// Host-side revert-rescue WIRING for QuollEditorPanel. The pure decision logic
// (arm/pair/decide) lives in revert-rescue.ts; this module owns the VS Code
// wiring AROUND it — the tracker instance + seed observe, the lock-free
// external-edit `documentChanged` coalescing (createTrailingDebounce), the
// shared `applyRestoreEdit` (a direct WorkspaceEdit, OUTSIDE the host-session
// reducer — like image-write), the alive-panel (text-tab-close) rescue, the
// onDidChangeTextDocument + tabGroups.onDidChangeTabs handler bodies, and the
// dispose-time rescue. It imports vscode for the restore-edit mechanics
// (mirroring disk-conflict-wiring.ts / image-write-wiring.ts) because that
// wiring IS this slice's substance.
//
// The VS Code event SOURCES are injected as `subscribe` closures (the
// theme-sync / editor-config / disk-conflict pattern): the panel owns the raw
// `workspace.onDidChangeTextDocument` / `window.tabGroups.onDidChangeTabs`
// subscription + the uri filter + `TabInput*` detection (kept vscode-side), and
// this factory owns the handler LOGIC. That keeps the factory a vscode-free-ish
// unit seam for the ordering-critical dispose rescue.
//
// PURE SIDE CHANNEL vs the reducer: applyRestoreEdit and the coalescing dispatch
// never enter the host-session core's write lock. The factory only READS the
// reducer's published lock state (isWriteLockHeld) to (a) skip a rescue that
// would race an in-flight apply and (b) route a lock-held change event to an
// immediate dispatch vs coalescing a lock-free one. The vscode-free decision
// logic stays pinned by revert-rescue.test.ts; the end-to-end behaviour by the
// preserve-unsaved-on-close / text-tab-close-preserves-edits / external-edit-
// propagates / external-fs-write-propagates / pending-edit-dispose-drain e2e,
// which this only re-wires.

import type { TextDocument } from "vscode";
import { Range, WorkspaceEdit, workspace } from "vscode";

import { createTrailingDebounce } from "./document-change-debounce.js";
import { minimalEditSpan } from "./minimal-edit.js";
import { createRevertRescueTracker } from "./revert-rescue.js";

/** Trailing-debounce window for coalescing LOCK-FREE external-edit
 *  `documentChanged` dispatches. ~100 ms: long enough to collapse the sub-ms
 *  bursts that dominate the cost (formatter, git checkout, an AI tool writing
 *  the open file) into one Document repost, short enough that a lone external
 *  edit still propagates promptly. Normal split-editor typing (~150 ms/char)
 *  exceeds this window, so each keystroke propagates on its pause. */
const DOC_CHANGE_DEBOUNCE_MS = 100;

export interface RevertRescueWiringDeps {
  /** The watched document. Read live (uri / getText / positionAt / isDirty /
   *  version) — for a given uri VS Code holds one TextDocument instance, so the
   *  event's `e.document` and this are the same object (the panel's subscribe
   *  closure gates by uri before forwarding). */
  readonly document: TextDocument;
  /** True once the panel is disposed. */
  readonly isDisposed: () => boolean;
  /** The reducer's published write-lock state (isWriteLockHeld(state)). Lazy —
   *  read at each decision point. */
  readonly isWriteLockHeld: () => boolean;
  /** Live host write capability (canWriteNow). Lazy. */
  readonly canWrite: () => boolean;
  /** True iff a built-in text editor / diff editor's modified side for this doc
   *  still holds it (computed by the panel over window.tabGroups). Read at
   *  rescue time (after teardown). */
  readonly hasSurvivingEditor: () => boolean;
  /** Dispatch a `documentChanged` reducer event at the given version. */
  readonly dispatchDocumentChanged: (documentVersion: number) => void;
  /** Surface an error toast (host showError). */
  readonly showError: (message: string) => void;
  /** Subscribe to this-doc text-document changes; the panel does the uri filter
   *  and forwards a bare tick. Returns a teardown. */
  readonly subscribeDocumentChange: (onChange: () => void) => () => void;
  /** Subscribe to this-doc text-tab closes; the panel does the TabInput*
   *  detection and forwards a bare tick. Returns a teardown. */
  readonly subscribeTextTabClose: (onClose: () => void) => () => void;
}

export interface RevertRescueWiring {
  /** Call in onDidDispose BEFORE `dispatch({ type: "disposed" })`: snapshots the
   *  write-lock (the transition clears it) and cancels any pending coalesced
   *  documentChanged. */
  prepareDispose(): void;
  /** Call AFTER `Disposable.from(...disposables).dispose()`: decide + apply the
   *  dispose-time revert rescue using the write-lock snapshot from
   *  prepareDispose(). */
  rescueOnDispose(): void;
  /** Tear down both subscriptions + cancel the debounce (pushed to disposables). */
  dispose(): void;
}

export function createRevertRescueWiring(deps: RevertRescueWiringDeps): RevertRescueWiring {
  const { document } = deps;

  // Revert-rescue: VS Code core reverts the shared working copy when THIS custom
  // editor tab is closed via "Don't Save", even while a built-in text editor for
  // the same resource stays open (CustomEditorInput never matches the text
  // editor's FileEditorInput, so core thinks we are the last holder of the dirty
  // state). CustomTextEditorProvider has no hook to PREVENT that revert, so we
  // REPAIR it. Seed with the current snapshot: the document can be dirty BEFORE
  // Quoll opens (the reported bug), and onDidChangeTextDocument never fires for
  // that pre-existing dirty content. Raw getText() (not canonicalised) — VS Code
  // owns this document's EOL and we read+write it.
  const revertRescue = createRevertRescueTracker();
  revertRescue.observe({
    isDirty: document.isDirty,
    content: document.getText(),
    at: Date.now(),
  });

  // Write-lock snapshot for the dispose-time rescue. Captured by prepareDispose()
  // BEFORE the reducer `disposed` transition clears the lock, read by
  // rescueOnDispose() after teardown — never a fresh read at rescue time (the
  // transition has already niled the lock by then, which would falsely allow a
  // rescue that races the in-flight apply's landing).
  let writeInFlightAtDispose = false;
  // Call-order guard for the two-method dispose contract. prepareDispose() flips
  // it true; rescueOnDispose() refuses to act (loud console.error + skip) if it
  // is still false. Without this, a future refactor that reorders onDidDispose or
  // adds an early-return before prepareDispose() would leave writeInFlightAtDispose
  // at its initial `false`, so rescueOnDispose() would proceed as if the lock were
  // free — racing an in-flight applyEdit with a stale span (silent wrong-offset
  // corruption, the exact failure this snapshot exists to prevent). The guard turns
  // that ordering regression into a loud, no-corruption skip.
  let preparedForDispose = false;

  // Coalesce a burst of LOCK-FREE external-edit events (formatter, git checkout,
  // an AI tool writing the open file, typing in a split text editor on the same
  // doc) into ONE trailing `documentChanged` dispatch. Each dispatch reposts the
  // full Document, which forces a wholesale webview re-parse + block-field
  // recompute + re-lint; without this, that runs once PER change event. The fire
  // thunk reads document.version LIVE (latest-wins).
  const scheduleDocumentChanged = createTrailingDebounce(DOC_CHANGE_DEBOUNCE_MS, () => {
    if (deps.isDisposed()) {
      return;
    }
    deps.dispatchDocumentChanged(document.version);
  });

  // Restore reverted-away dirty bytes via a direct WorkspaceEdit (OUTSIDE the
  // reducer — like image-write and the dispose rescue). Shared by the dispose-time
  // rescue and the alive-panel (text-tab-close) rescue. Success is SILENT (the
  // surviving/live editor visibly holds the restored bytes); only failure is
  // surfaced. `onFailure` lets the ALIVE path reseed the webview to the real doc
  // state when the restore could not land (the dispose path passes none — the
  // panel is already gone, nothing to reseed).
  const applyRestoreEdit = (content: string, onFailure?: () => void): void => {
    const span = minimalEditSpan(document.getText(), content);
    const edit = new WorkspaceEdit();
    edit.replace(
      document.uri,
      new Range(document.positionAt(span.from), document.positionAt(span.to)),
      span.insert
    );
    void workspace.applyEdit(edit).then(
      (ok) => {
        if (!ok) {
          deps.showError("Quoll could not restore your unsaved changes after closing the editor.");
          onFailure?.();
        }
      },
      (err: unknown) => {
        deps.showError(
          `Quoll could not restore your unsaved changes: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        onFailure?.();
      }
    );
  };

  // Alive-panel analogue of the dispose-time revert-rescue. Called from BOTH
  // triggers (the tab-close handler and the document-change handler) because the
  // revert onDidChangeTextDocument and the tab-close onDidChangeTabs can arrive in
  // either order; decideOnAliveRevert consumes both tokens so the second call is a
  // no-op. On a positive decision it BEST-EFFORT suppresses the debounced disk
  // (revert) repost — cancel() clears a timer a revert change-event may already
  // have scheduled, and the change-event caller ALSO early-returns so it never
  // schedules one. The restore's OWN change event then reposts the authoritative
  // dirty Document as the FINAL state. On restore FAILURE the onFailure reseeds the
  // webview to the real (disk) doc so the live panel never silently diverges (the
  // toast already warned the user). Returns true iff a rescue was performed.
  // Skipped when the write lock is held (decideOnAliveRevert → rescue:false) so it
  // never races an in-flight apply.
  const maybeRescueAliveRevert = (): boolean => {
    if (deps.isDisposed()) {
      return false;
    }
    const decision = revertRescue.decideOnAliveRevert({
      writeInFlight: deps.isWriteLockHeld(),
      canWrite: deps.canWrite(),
      currentContent: document.getText(),
      at: Date.now(),
    });
    if (!decision.rescue) {
      return false;
    }
    scheduleDocumentChanged.cancel();
    applyRestoreEdit(decision.content, () => {
      if (!deps.isDisposed()) {
        deps.dispatchDocumentChanged(document.version);
      }
    });
    return true;
  };

  // onDidChangeTextDocument body (this doc only — the panel's subscribe closure
  // gates by uri). Feed the tracker every transition (raw getText() — no
  // per-keystroke canonicalise), attempt the reverse-direction alive rescue, then
  // route the change: lock-held change events go to the reducer IMMEDIATELY (the
  // host's OWN in-flight apply fires under the lock; an external edit racing the
  // apply→settle window also arrives locked — the reducer owns the deferral +
  // non-OK settlement ordering and must see these in order). Only lock-FREE
  // external bursts coalesce.
  const onDocumentChange = (): void => {
    revertRescue.observe({
      isDirty: document.isDirty,
      content: document.getText(),
      at: Date.now(),
    });
    if (maybeRescueAliveRevert()) {
      return;
    }
    if (deps.isWriteLockHeld()) {
      // Supersede any pending coalesced timer: the immediate dispatch carries an
      // equal-or-higher version, so a later trailing fire would only no-op.
      scheduleDocumentChanged.cancel();
      deps.dispatchDocumentChanged(document.version);
      return;
    }
    scheduleDocumentChanged.schedule();
  };

  // onDidChangeTabs body: a built-in text editor (or diff editor's modified side)
  // for THIS document was CLOSED — the causal token for the reverse-direction
  // rescue. Record the close time and attempt the rescue: revert-first restores
  // now; close-first restores when the document-change handler's call fires.
  const onTextTabClose = (): void => {
    revertRescue.observeTextTabClose(Date.now());
    maybeRescueAliveRevert();
  };

  const teardownDocChange = deps.subscribeDocumentChange(onDocumentChange);
  const teardownTabClose = deps.subscribeTextTabClose(onTextTabClose);

  return {
    prepareDispose(): void {
      // Snapshot the write lock BEFORE the disposed transition clears it — the
      // rescue must skip when a reducer applyEdit is in flight (else it races that
      // apply's landing with a stale span = wrong-offset corruption).
      writeInFlightAtDispose = deps.isWriteLockHeld();
      preparedForDispose = true;
      // Drop any pending coalesced documentChanged — the panel is gone; the
      // trailing dispatch would be a no-op anyway (the thunk's disposed guard),
      // but cancelling releases the timer + closure promptly.
      scheduleDocumentChanged.cancel();
    },

    rescueOnDispose(): void {
      // Call-order guard: rescueOnDispose MUST follow prepareDispose in the same
      // lifecycle (else writeInFlightAtDispose is an untrustworthy default `false`).
      // Skip loudly rather than risk a rescue that races an in-flight apply — a
      // skipped rescue is visible + undoable; a wrong-offset corruption is not.
      if (!preparedForDispose) {
        console.error(
          "[quoll] revert-rescue: rescueOnDispose() called without prepareDispose(); skipping rescue"
        );
        return;
      }
      // Revert-rescue. If closing THIS custom editor made VS Code revert the
      // shared working copy while another editor still holds the document,
      // re-apply the dirty bytes so the still-open editor does not silently lose
      // them. Runs AFTER teardown: the edit targets the TextDocument (not the
      // disposed webview), and the surviving editor keeps the document alive so
      // applyEdit is not a no-op.
      const rescue = revertRescue.decideOnDispose({
        writeInFlight: writeInFlightAtDispose,
        hasSurvivingEditor: deps.hasSurvivingEditor(),
        canWrite: deps.canWrite(),
        currentContent: document.getText(),
        disposedAt: Date.now(),
      });
      if (rescue.rescue) {
        applyRestoreEdit(rescue.content);
      }
    },

    dispose(): void {
      scheduleDocumentChanged.cancel();
      teardownDocChange();
      teardownTabClose();
    },
  };
}
