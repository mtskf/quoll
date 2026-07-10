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

export interface AliveRevertContext {
  /** A reducer applyEdit was in flight (write lock held). When true the
   *  rescue is skipped so it never races the in-flight apply's landing. */
  readonly writeInFlight: boolean;
  readonly canWrite: boolean;
  /** Live document text now (the reverted / on-disk bytes). */
  readonly currentContent: string;
  /** Now (epoch ms), injected — an absolute freshness bound on the pair. */
  readonly at: number;
}

export interface RevertRescueTracker {
  /** Feed a (isDirty, content) snapshot. Call at construction with the initial
   *  state and on every onDidChangeTextDocument. */
  observe(snapshot: DirtySnapshot): void;
  /** Decide at dispose whether the close reverted still-needed dirty bytes. */
  decideOnDispose(ctx: RescueContext): RescueDecision;
  /** Record that a built-in text editor (or diff editor's modified side) for
   *  THIS document was closed, at `at` (epoch ms). The causal token paired
   *  against an armed revert by decideOnAliveRevert. */
  observeTextTabClose(at: number): void;
  /** Decide, while the panel is ALIVE, whether a text-tab close reverted
   *  still-needed dirty bytes. Fires only when an armed revert and a text-tab
   *  close are tightly paired in time (≤ pairingWindowMs apart). Consumes BOTH
   *  tokens on a positive decision so neither is reused by a later event. */
  decideOnAliveRevert(ctx: AliveRevertContext): RescueDecision;
}

const NO_RESCUE: RescueDecision = { rescue: false };

export function createRevertRescueTracker(
  opts: { readonly windowMs?: number; readonly pairingWindowMs?: number } = {}
): RevertRescueTracker {
  // Failure asymmetry (deliberate): too-SHORT a window mis-classifies a genuine
  // close-triggered revert as stale -> the original silent data-loss bug
  // returns; too-LONG only risks a benign, visible, undoable re-dirty when a
  // user manually reverts (or undoes to clean) and closes within the window. So
  // bias LONG. The measured close-revert->dispose gap is ~9 ms; 2500 ms clears
  // it by orders of magnitude while staying well under human revert-then-close time.
  const windowMs = opts.windowMs ?? 2500;
  // Causal-pairing window between a text-tab close and the revert it triggered.
  // The two failure modes are ASYMMETRIC (per revert-rescue's existing
  // "bias LONG" note): too TIGHT → a genuine close-revert whose two events
  // straddle the window is missed → the ORIGINAL silent data loss (bad); too
  // LOOSE → a manual "Revert File" then an unrelated close within the window
  // falsely restores → a benign, visible, UNDOABLE re-dirty (fine). So bias
  // toward the longer side, bounded ABOVE only by deliberate two-action human
  // spacing (moving+clicking twice is ≫ 1 s, far above any close-with-discard,
  // whose revert-change-event and onDidChangeTabs both fire inside one
  // synchronous VS Code close operation). The concrete default is CONFIRMED
  // against the real revert↔onDidChangeTabs gap measured in the Task 3 E2E
  // (NOT the forward fix's revert→dispose gap, a different event pair). 250 ms
  // is the starting default; Task 3 widens it if the measured gap + full-suite
  // load margin warrants, staying well under human two-action spacing.
  const pairingWindowMs = opts.pairingWindowMs ?? 250;
  let lastDirtyContent: string | null = null;
  let pendingRevert: { content: string; at: number } | null = null;
  let lastCloseAt: number | null = null;

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

    observeTextTabClose(at) {
      lastCloseAt = at;
    },

    decideOnAliveRevert({ writeInFlight, canWrite, currentContent, at }) {
      if (writeInFlight) {
        return NO_RESCUE; // never race an in-flight reducer applyEdit
      }
      if (pendingRevert === null || lastCloseAt === null) {
        return NO_RESCUE; // need BOTH a revert and a close to pair
      }
      if (!canWrite) {
        return NO_RESCUE;
      }
      // Causal pairing: the close and the revert must be tightly paired in time
      // (part of one close-with-discard action) — NOT merely each recent. This
      // is what keeps a manual revert from being resurrected by a later,
      // unrelated close within the loose freshness window (Codex #1).
      if (Math.abs(lastCloseAt - pendingRevert.at) >= pairingWindowMs) {
        return NO_RESCUE;
      }
      // Absolute freshness bound (defensive): never act on an ancient pair.
      if (at - pendingRevert.at >= windowMs) {
        return NO_RESCUE;
      }
      if (currentContent === pendingRevert.content) {
        return NO_RESCUE; // nothing was lost
      }
      const { content } = pendingRevert;
      pendingRevert = null; // consume both tokens (the alive tracker lives on)
      lastCloseAt = null;
      return { rescue: true, content };
    },
  };
}
