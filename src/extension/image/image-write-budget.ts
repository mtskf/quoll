// Per-session cumulative volume cap for the image-WRITE path.
//
// The per-message caps in image-write-service (the MAX_IMAGE_DATA_LENGTH string
// bound + the 10 MB decode limit) bound a SINGLE write; they do nothing against
// a compromised webview — the exact adversary image-write-wiring gates against —
// that loops `image-write` with distinct PNG-magic-prefixed random payloads.
// Each such payload content-addresses to a NEW <docFolder>/assets/ file, so the
// per-message caps are individually satisfied while the disk fills silently.
//
// Other webview→host channels are already count-bounded PER MESSAGE (e.g.
// MAX_LINT_DIAGNOSTICS caps diagnostics on each inbound lint message), but none
// keeps a running session-lifetime total — this budget is the FIRST such bound
// in the codebase, added because the image-write path is uniquely able to turn a
// message loop into unbounded disk growth. It is a generous cumulative byte
// ceiling scoped to the editor session (one budget per panel). Once crossed it
// rejects further writes and warns the user ONCE (a per-write toast would itself
// be a notification-flood vector). Real paste flows — even bulk multi-image
// paste — never approach it.

/** Cumulative image bytes a single editor session may write to ./assets/.
 *  512 MiB ≈ 50 full-size (10 MB) images — orders of magnitude beyond any real
 *  paste session, yet a hard stop against an unbounded write loop. A session is
 *  one open panel; reopening the document starts a fresh budget. */
export const SESSION_IMAGE_WRITE_BUDGET_BYTES = 512 * 1024 * 1024;

/** User-facing warning shown ONCE when the session budget is first exceeded. */
export const SESSION_IMAGE_WRITE_BUDGET_TOAST =
  "Quoll: image paste limit reached for this document — reopen it to insert more images.";

export interface SessionVolumeBudget {
  /** Charge `byteLength` against the session budget. Returns true (and records
   *  the spend) when the write may proceed; false once the cumulative cap would
   *  be exceeded — in which case `onExceeded` fires exactly once across the
   *  session's lifetime, no matter how many further writes are attempted.
   *  Reserve BEFORE the async write so concurrent (fire-and-forget) writes can't
   *  each independently pass the check and overshoot the cap; `release` the
   *  reservation if that write then fails (see below). */
  reserve(byteLength: number): boolean;
  /** Refund a prior `reserve(byteLength)` whose write did not reach disk (an FS
   *  failure after the reservation). Keeps the running total counting only bytes
   *  actually written, so a run of transient write failures can't exhaust the
   *  session cap. No-op below zero. Never un-warns: a released reservation was,
   *  by definition, admitted — it never tripped `onExceeded`. */
  release(byteLength: number): void;
}

// Guard the numeric domain the running total assumes (non-negative integer).
// The sole production caller passes a `Uint8Array.length`, always safe — but a
// NaN would poison `spent` permanently (every `NaN > cap` is false, silently
// disabling the cap: the exact failure this module exists to prevent), and a
// negative would rewind it. Fail loud on the contract violation instead.
function assertByteLength(byteLength: number): void {
  if (!Number.isInteger(byteLength) || byteLength < 0) {
    throw new RangeError(
      `SessionVolumeBudget: byteLength must be a non-negative integer, got ${byteLength}`
    );
  }
}

export function createSessionVolumeBudget(
  budgetBytes: number,
  onExceeded: () => void
): SessionVolumeBudget {
  let spent = 0;
  let warned = false;
  return {
    reserve(byteLength) {
      assertByteLength(byteLength);
      if (spent + byteLength > budgetBytes) {
        if (!warned) {
          warned = true;
          onExceeded();
        }
        return false;
      }
      spent += byteLength;
      return true;
    },
    release(byteLength) {
      assertByteLength(byteLength);
      spent = Math.max(0, spent - byteLength);
    },
  };
}
