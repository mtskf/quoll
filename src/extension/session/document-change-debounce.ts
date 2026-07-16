// Host-side trailing debounce for the open document's `documentChanged`
// dispatch. One responsibility: coalesce a burst of matching
// `workspace.onDidChangeTextDocument` events into a single trailing reducer
// dispatch, so a burst of external edits (formatter, git checkout, an AI tool
// writing the open file, typing in a split text editor) reposts the full
// Document to the webview ONCE instead of once per change event — each post
// triggers a wholesale webview re-parse + block-field recompute + re-lint.
//
// Deliberately a bare primitive: the caller owns the fire thunk, which reads
// `document.version` LIVE at fire time (latest-wins) so the coalesced dispatch
// carries the newest version and the reducer's version-identical no-op guard
// and write-lock deferral both still hold (staleness detection is unaffected —
// the `edit` reducer arm snapshots the live version itself). Cancel on dispose.
//
// `onFire` MUST NOT throw: it runs inside a `setTimeout` callback, which the
// Node event loop invokes OUTSIDE VS Code's extension-host tryCatch wrapper (a
// throw would not be caught-and-logged like a throw from the change-event
// handler). The panel's fire thunk dispatches `documentChanged` (a pure reducer
// step + `disposed`-guarded `postDocument`) AND calls `caretWiring.refreshCount()`
// (`document.getText()` on the live doc + the total count formatters) — neither
// throws, so the invariant holds.

export interface TrailingDebounce {
  /** (Re)arm the trailing timer. Repeated calls within `delayMs` collapse to
   *  one eventual `onFire()`. */
  schedule(): void;
  /** Clear any pending timer WITHOUT firing. Idempotent; safe with no pending
   *  timer. Call on dispose. */
  cancel(): void;
}

export function createTrailingDebounce(delayMs: number, onFire: () => void): TrailingDebounce {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    schedule(): void {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        onFire();
      }, delayMs);
    },
    cancel,
  };
}
