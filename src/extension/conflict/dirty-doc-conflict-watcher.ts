// Host-side dirty-doc on-disk conflict watcher.
//
// Why: VS Code auto-reverts a CLEAN externally-changed TextDocument (pinned by
// external-fs-write-propagates.test.ts) but SKIPS reverting a DIRTY model to
// protect unsaved edits — so a Quoll doc with unsaved edits silently shows
// stale content while disk has moved on. This per-panel watcher detects that
// divergence and surfaces a user-confirmed conflict prompt.
//
// This module owns the load-bearing ORCHESTRATION only — the debounce timer,
// the single-flight guard, and the read → prompt → reload flow with its subtle
// ordering. It stays vscode-free (mirrors edit-settled-barrier.ts /
// document-change-debounce.ts): every VS Code touch — the file-system watcher,
// the disk read, the prompt, the revert — is INJECTED as a dep, so the panel
// keeps the VS Code wiring and this factory is unit-testable. The pure
// "should we even prompt" predicate lives in disk-conflict.ts and is reused
// here (never duplicated).

import { sameDocumentText, shouldPromptDiskConflict } from "./disk-conflict.js";

// Debounce for the dirty-doc on-disk conflict watcher. External tools often
// write a file in several fs operations (truncate + write, or temp + rename);
// coalesce the burst into one divergence check + at most one prompt.
export const CONFLICT_DEBOUNCE_MS = 300;

export interface DirtyDocConflictWatcherDeps {
  /** Subscribe to external change/create signals for the watched folder. The
   *  handler is invoked with the changed URI as a string; the factory filters
   *  by `documentUriString` itself. Returns a teardown for the subscription,
   *  run on dispose. */
  readonly subscribe: (onSignal: (changedUriString: string) => void) => () => void;
  /** Subscribe to the platform's save notification for this document (fired
   *  after the write). Returns a teardown, run on dispose. */
  readonly subscribeSave: (onSave: () => void) => () => void;
  /** The watched document's URI string, for filtering signals to this doc. */
  readonly documentUriString: string;
  /** True once the panel is disposed — every async continuation re-checks it. */
  readonly isDisposed: () => boolean;
  /** Live dirty flag of the model (the precondition for a conflict). */
  readonly isDirty: () => boolean;
  /** Read the on-disk content, decoded to comparable text. Resolves to `null`
   *  when the bytes are not faithfully comparable as UTF-8 (non-UTF-8 encoding);
   *  the watcher then skips the prompt. Rejects if the file is unreadable. */
  readonly readDiskText: () => Promise<string | null>;
  /** Canonical in-memory buffer text, for the divergence compare. */
  readonly readBufferText: () => string;
  /** Show the conflict prompt; resolves to the chosen action label (or
   *  undefined when dismissed). Only the "Reload from disk" label triggers a
   *  reload — the factory compares against `reloadChoice`. */
  readonly promptReload: () => Thenable<string | undefined>;
  /** The action label that means "reload"; a prompt resolving to anything else
   *  (or undefined) is treated as "keep my edits" (a no-op). */
  readonly reloadChoice: string;
  /** Perform the user-confirmed true revert from disk. */
  readonly reloadFromDisk: () => Promise<void>;
  /** Surface an error toast. */
  readonly showError: (message: string) => void;
  /** Debounce window in ms. Defaults to CONFLICT_DEBOUNCE_MS; the unit suite
   *  overrides it to keep fake-timer advances small. */
  readonly debounceMs?: number;
}

export interface DirtyDocConflictWatcher {
  /** Cancel any pending debounce and tear down both subscriptions. */
  dispose(): void;
}

export function createDirtyDocConflictWatcher(
  deps: DirtyDocConflictWatcherDeps
): DirtyDocConflictWatcher {
  const debounceMs = deps.debounceMs ?? CONFLICT_DEBOUNCE_MS;

  let conflictTimer: ReturnType<typeof setTimeout> | null = null;
  // Spans the WHOLE user action (prompt open → reload settled/failed) so a
  // watcher event mid-prompt or mid-reload cannot start a second prompt
  // (Codex C84).
  let conflictActionInFlight = false;
  // What this document last wrote to disk, or null when unknown. A save's own fs
  // signal can be checked after the user has typed on, so the dirty buffer then
  // differs from a disk that holds nothing but our save: matching it is how the
  // check tells our write from an external one. Cleared as soon as disk is seen
  // to hold anything else, so a later external write-back of those same bytes
  // (a branch switch away and back) still prompts. No ignore window: a
  // different write prompts however soon after the save it lands.
  let savedText: string | null = null;
  const onSave = (): void => {
    // Dirty at the notification ⇒ edits landed after the write, so the buffer is
    // not what was saved and the saved bytes are unknown.
    savedText = deps.isDirty() ? null : deps.readBufferText();
  };

  const checkConflict = async (): Promise<void> => {
    if (deps.isDisposed() || conflictActionInFlight) {
      return;
    }
    // Clean docs auto-revert via the platform, so a clean doc has nothing to
    // prompt about — it is read only to learn whether disk still holds our save.
    // Cheap synchronous early-exit BEFORE claiming the single-flight flag.
    if (!deps.isDirty() && savedText === null) {
      return;
    }
    // Claim the flag BEFORE the async read (Codex C82): a slow readFile must
    // not let a second debounce-fired checkConflict start a concurrent read +
    // duplicate prompt. The flag spans the entire action (read → prompt →
    // reload); `finally` always releases it (return / throw both run it).
    conflictActionInFlight = true;
    const savedBeforeRead = savedText;
    try {
      let diskText: string | null;
      try {
        diskText = await deps.readDiskText();
      } catch (err) {
        // Deleted / unreadable between the event and this read — not a content
        // conflict; the platform owns deleted-file UX. Log for triage.
        console.warn("[quoll] dirty-doc conflict: disk read failed", err);
        return;
      }
      if (deps.isDisposed()) {
        return;
      }
      // Untrusted disk content (non-UTF-8 read byte-wise): we cannot faithfully
      // compare it to the buffer, so we must not fire a spurious prompt. Treat it
      // like a no-divergence result (the file simply is not covered by the
      // UTF-8-only conflict check on this VS Code version floor).
      if (diskText === null) {
        return;
      }
      // A save that landed during readFile makes these bytes stale: judging them
      // against the newer save would forget it as foreign. Drop this check.
      if (savedText !== savedBeforeRead) {
        return;
      }
      if (savedText !== null) {
        if (sameDocumentText(diskText, savedText)) {
          return;
        }
        savedText = null;
      }
      if (!shouldPromptDiskConflict(deps.isDirty(), diskText, deps.readBufferText())) {
        return;
      }
      const choice = await deps.promptReload();
      if (deps.isDisposed() || choice !== deps.reloadChoice) {
        // "Keep my edits" / dismissed → no-op: unsaved edits stay, and the
        // next save still hits VS Code's native save-conflict guard.
        return;
      }
      await deps.reloadFromDisk();
      // Post-condition (no silent success): if the revert silently no-oped
      // (did not target the custom-editor-backed doc), the model is still
      // dirty. Surface it rather than leaving stale content with no feedback
      // for an explicit user action (Codex C90 / error-handler B).
      if (!deps.isDisposed() && deps.isDirty()) {
        deps.showError(
          "Quoll: could not reload the file from disk — use File: Revert File to reload it manually."
        );
      }
    } catch (err) {
      console.error("[quoll] dirty-doc conflict: reload failed", err);
      deps.showError(
        `Quoll: could not reload the file from disk: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    } finally {
      conflictActionInFlight = false;
    }
  };

  // Debounced, URI-filtered signal. Coalesces an external tool's multi-op write
  // burst (truncate+write, or temp+rename) into one check.
  const onSignal = (changedUriString: string): void => {
    if (deps.isDisposed() || changedUriString !== deps.documentUriString) {
      return;
    }
    if (conflictTimer !== null) {
      clearTimeout(conflictTimer);
    }
    conflictTimer = setTimeout(() => {
      conflictTimer = null;
      void checkConflict();
    }, debounceMs);
  };

  const unsubscribe = deps.subscribe(onSignal);
  const unsubscribeSave = deps.subscribeSave(onSave);

  return {
    dispose(): void {
      // Cancel a pending debounce on dispose so a late timer cannot fire
      // checkConflict after teardown (checkConflict also re-checks isDisposed).
      if (conflictTimer !== null) {
        clearTimeout(conflictTimer);
        conflictTimer = null;
      }
      unsubscribe();
      unsubscribeSave();
    },
  };
}
