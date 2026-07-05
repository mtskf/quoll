// Host-side edit-applied barrier for the document side channels
// (context-handoff / codex-context-handoff / switch-to-text).
//
// Why: PR #54 flushes the pending debounced Edit BEFORE posting a handoff, so
// the just-typed bytes reach the host FIRST (FIFO). But VS Code does NOT
// serialise async message handlers: the host `edit` arm acquires the write
// lock and kicks off `workspace.applyEdit(...)` which settles LATER, so the
// FIFO-next handoff arm can run while `document.getText()` / `lineCount` /
// `isDirty` still reflect the PRE-edit snapshot (stale save / clamp /
// whole-file add). This barrier defers a side-channel thunk while the host
// write lock is held and drains it once the lock is released on a SUCCESSFUL
// settlement, so the side channel observes the APPLIED document.
//
// Outcome-aware: a FAILED apply (refused / rejected / throw) releases the lock
// but the LATEST apply did not land, so a deferred handoff would read stale /
// inconsistent bytes (in the single-edit case the document is still pre-edit;
// in the stash-drain case the earlier edit landed but the latest failed,
// leaving webview/disk inconsistent) — it is DROPPED instead (`settle(false)`).
// The reducer already surfaces the save-failure toast, so this is coherent.
//
// Invariant preserved: the side channels still NEVER enter the host-session
// reducer or mutate a document — this barrier only READS the reducer's
// published lock state (via `isWriteLockHeld(state)`, injected as `isLocked`)
// and the panel's `disposed` flag (injected as `isDisposed`). It adds no core
// event, no core state, no document write.

export interface EditSettledBarrierDeps {
  /** True while the host write lock is held — reads the reducer's published
   *  `isWriteLockHeld(state)`. A flushed edit's applyEdit is in flight. */
  readonly isLocked: () => boolean;
  /** True once the panel is disposed — deferred side channels are then dropped
   *  (the panel is gone; running a handoff against a torn-down panel is wrong). */
  readonly isDisposed: () => boolean;
  /** Called when a side-channel thunk throws synchronously, so one thunk's
   *  throw neither aborts the drain loop (stranding later thunks + the caller's
   *  dispatch drain) nor unwinds the immediate-run caller. Defaults to
   *  console.error. */
  readonly onError?: (err: unknown) => void;
}

export interface EditSettledBarrier {
  /** Run `sideChannel` now if the write lock is free (today's behaviour), else
   *  DEFER it behind the lock so it observes the applied document after a
   *  successful settlement. A no-op post-dispose. A synchronous throw is
   *  isolated via `onError`.
   *
   *  `onDrop` (optional) fires exactly when the thunk is DROPPED without ever
   *  running — a failed-apply `settle(false)` or a dispose. Callers that set an
   *  at-receipt guard (e.g. the Codex single-flight `codexHandoffInFlight`)
   *  MUST use it to release that guard, else a dropped deferred thunk leaks the
   *  guard forever (its own `.finally` never runs). It never fires when the
   *  thunk runs (the thunk owns its own completion) and is isolated via
   *  `onError` so a throwing `onDrop` cannot abort a drop loop. */
  run(sideChannel: () => void, onDrop?: () => void): void;
  /** Call after every reducer step. `applied` is true unless this step was a
   *  FAILED apply settlement. Drains the deferred side channels (FIFO) only
   *  when the write lock is now FULLY released AND `applied` is true AND the
   *  panel is alive; otherwise DROPS them (dispose or failed apply — firing each
   *  entry's `onDrop`) or waits (still locked — a stash-drain re-apply). Cheap
   *  no-op when nothing waits. */
  settle(applied: boolean): void;
}

interface DeferredEntry {
  readonly run: () => void;
  readonly onDrop?: () => void;
}

export function createEditSettledBarrier(deps: EditSettledBarrierDeps): EditSettledBarrier {
  const onError =
    deps.onError ?? ((err: unknown) => console.error("[quoll] deferred side channel threw", err));
  const deferred: DeferredEntry[] = [];

  const isolate = (fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      onError(err);
    }
  };

  const dropAll = (): void => {
    // Fire each entry's onDrop (guard release) before clearing. Splice-first so a
    // re-entrant enqueue lands in a fresh queue, not this drop batch.
    const dropped = deferred.splice(0);
    for (const entry of dropped) {
      if (entry.onDrop) {
        isolate(entry.onDrop);
      }
    }
  };

  return {
    run(sideChannel: () => void, onDrop?: () => void): void {
      if (deps.isDisposed()) {
        // The thunk will never run — release any at-receipt guard.
        if (onDrop) {
          isolate(onDrop);
        }
        return;
      }
      if (deps.isLocked()) {
        deferred.push({ run: sideChannel, onDrop });
        return;
      }
      isolate(sideChannel);
    },
    settle(applied: boolean): void {
      if (deferred.length === 0) {
        return;
      }
      // Drop (never run) when disposed OR the releasing settlement failed to
      // apply the edit — the edit did not land, so a deferred handoff would
      // read the un-applied (pre-edit) document. Fire each onDrop so at-receipt
      // guards are released.
      if (deps.isDisposed() || !applied) {
        dropAll();
        return;
      }
      // Still locked (a stash-drain re-apply re-acquired the lock) → wait for
      // the next settlement.
      if (deps.isLocked()) {
        return;
      }
      // Splice-then-run so a side channel that (indirectly) enqueues another is
      // not drained inside this loop — it waits for the next settle.
      const runs = deferred.splice(0);
      for (const entry of runs) {
        isolate(entry.run);
      }
    },
  };
}
