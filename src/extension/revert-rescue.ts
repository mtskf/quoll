// Pure, vscode-free "revert rescue" decision for the QuollEditorPanel dispose
// path. VS Code core reverts the shared text-file working copy when a custom
// editor tab is closed via "Don't Save", even when a built-in text editor for
// the same resource is still open (CustomEditorInput.matches never matches a
// FileEditorInput — see the panel dispose wiring + docs/LEARNING.md). The
// provider has no save/revert hook to PREVENT this, so the panel REPAIRS it: it
// feeds every (isDirty, content) transition here, and on dispose asks whether
// the close reverted still-needed bytes. All time / lock state is injected
// (`at` / `disposedAt` / `writeInFlight`) so this stays property-testable with
// no Date.now() and no vscode import.

export interface DirtySnapshot {
  readonly isDirty: boolean;
  /** Raw document text (VS Code EOL-normalises a loaded doc; same-doc self-consistent). */
  readonly content: string;
  /** Observation time (ms epoch), injected by the caller. */
  readonly at: number;
}

export interface RescueContext {
  /** A reducer applyEdit was in flight at dispose (write lock held). Captured
   *  BEFORE the `disposed` transition, which clears the lock. When true the
   *  rescue is skipped so it never races the in-flight apply's landing. */
  readonly writeInFlight: boolean;
  /** Another editor (e.g. the built-in text editor / a diff editor) still holds this document. */
  readonly hasSurvivingEditor: boolean;
  readonly canWrite: boolean;
  /** Document text at dispose time (the reverted / on-disk bytes). */
  readonly currentContent: string;
  readonly disposedAt: number;
}

export type RescueDecision =
  | { readonly rescue: false }
  | { readonly rescue: true; readonly content: string };

export interface RevertRescueTracker {
  /** Feed a (isDirty, content) snapshot. Call at construction with the initial
   *  state and on every onDidChangeTextDocument. */
  observe(snapshot: DirtySnapshot): void;
  /** Decide at dispose whether the close reverted still-needed dirty bytes. */
  decideOnDispose(ctx: RescueContext): RescueDecision;
}

const NO_RESCUE: RescueDecision = { rescue: false };

export function createRevertRescueTracker(
  opts: { readonly windowMs?: number } = {}
): RevertRescueTracker {
  // Failure asymmetry (deliberate): too-SHORT a window mis-classifies a genuine
  // close-triggered revert as stale -> the original silent data-loss bug
  // returns; too-LONG only risks a benign, visible, undoable re-dirty when a
  // user manually reverts (or undoes to clean) and closes within the window. So
  // bias LONG. The measured close-revert->dispose gap is ~9 ms; 2500 ms clears
  // it by orders of magnitude while staying well under human revert-then-close time.
  const windowMs = opts.windowMs ?? 2500;
  let lastDirtyContent: string | null = null;
  let pendingRevert: { content: string; at: number } | null = null;

  return {
    observe({ isDirty, content, at }) {
      if (isDirty) {
        lastDirtyContent = content;
        pendingRevert = null; // a fresh dirty edit supersedes any prior revert
        return;
      }
      // Clean event. A redundant/already-clean event (lastDirtyContent === null)
      // must NOT disarm a pending revert: VS Code can fire the revert as a
      // content-change event AND a separate empty dirty-flip clean event, and
      // the second would otherwise wipe the arm. Only a genuine dirty->clean
      // transition classifies: a REVERT changes the content vs the last dirty
      // bytes; a SAVE leaves it equal (disk now holds the dirty bytes).
      if (lastDirtyContent === null) {
        return;
      }
      pendingRevert = content !== lastDirtyContent ? { content: lastDirtyContent, at } : null;
      lastDirtyContent = null;
    },

    decideOnDispose({ writeInFlight, hasSurvivingEditor, canWrite, currentContent, disposedAt }) {
      if (writeInFlight) {
        return NO_RESCUE; // never race an in-flight reducer applyEdit
      }
      if (pendingRevert === null) {
        return NO_RESCUE;
      }
      if (!hasSurvivingEditor || !canWrite) {
        return NO_RESCUE;
      }
      if (disposedAt - pendingRevert.at >= windowMs) {
        return NO_RESCUE; // stale: a human revert earlier, not this close
      }
      if (currentContent === pendingRevert.content) {
        return NO_RESCUE; // nothing was lost
      }
      return { rescue: true, content: pendingRevert.content };
    },
  };
}
