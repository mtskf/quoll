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
  // user manually reverts and closes within the window. So bias LONG. The
  // measured close-revert->dispose gap is ~9 ms; 2500 ms clears it by orders of
  // magnitude while staying well under human revert-then-close time.
  //
  // Residual scope (VERIFIED, PR #155): the only within-window false-fire is a
  // manual "Revert File" then close. An UNDO/REDO back to clean is NOT a
  // residual — the content-comparison below already neutralises it. VS Code
  // fires an undo as TWO events: (1) a still-DIRTY content change back to the
  // disk bytes (this resets `lastDirtyContent` via the `if (isDirty)` branch),
  // then (2) the dirty->clean flip, whose content now EQUALS `lastDirtyContent`
  // so it classifies as a SAVE and does not arm. (A close-triggered revert, by
  // contrast, fires ONE clean event whose content differs from the last dirty
  // bytes -> arms.) A `TextDocumentChangeReason.Undo/Redo` discriminator was
  // evaluated and REJECTED: event (2) — the only arming site — carries
  // reason === undefined (the Undo reason rides event (1), which never reaches
  // the arming code), so the check would be dead code. Manual "Revert File"
  // carries reason === undefined and changes content in one event like a close
  // revert, so no reason check can separate it either; the window is the only
  // discriminator and its residual is accepted (visible + undoable, never data
  // loss). Both the two-event undo sequence and the end-to-end "undo then close
  // does not resurrect" outcome are pinned by tests (see the tracker unit suite
  // and the preserve-unsaved-on-close e2e).
  const windowMs = opts.windowMs ?? 2500;
  // Causal-pairing window between a text-tab close and the revert it triggered:
  // decideOnAliveRevert restores only when |lastCloseAt - pendingRevert.at| is
  // within this window. A genuine close-with-discard fires its revert-change
  // event and onDidChangeTabs inside ONE synchronous VS Code close operation —
  // measured at 0–1 ms apart (revert→dispose in the forward path is ~9 ms; both
  // are effectively instantaneous), and load-insensitive since they are event
  // dispatches, not CPU work. The window must be:
  //   - comfortably ABOVE that gap (missing a real pair = the ORIGINAL silent
  //     data loss — the worse failure), and
  //   - BELOW the time it takes a human to perceive an UNRELATED same-doc tab
  //     close and then invoke a manual "Revert File" (perceive + command
  //     invocation ≫ 250 ms). Otherwise a lingering close token pairs with a
  //     later manual revert and resurrects content the user explicitly discarded
  //     — the exact "external edit wins" violation this guard exists to prevent.
  // 120 ms sits between those bounds (≈10× the ~9 ms worst observed close-side
  // gap, well under human perceive-then-invoke latency). Time is the only
  // discriminator available: a genuine close-first revert arrives ~1 ms after
  // its close, a manual revert 100s of ms after an unrelated one — so this is a
  // window, not an ordering rule (staying robust to VS Code firing the two
  // events in either order; the alive path handles both). RESIDUAL (accepted,
  // same benign class as the dispose-path window above): a manual revert within
  // 120 ms of an unrelated same-doc close still false-pairs — but that timing is
  // below human perception+action latency, so it is not reachable in practice,
  // and the outcome is a visible, UNDOABLE re-dirty, never data loss.
  const pairingWindowMs = opts.pairingWindowMs ?? 120;
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
