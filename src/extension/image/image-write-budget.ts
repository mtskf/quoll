// Per-session cumulative volume cap for the image-WRITE path.
//
// The per-message caps in image-write-service (the MAX_IMAGE_DATA_LENGTH string
// bound + the 10 MB decode limit) bound a SINGLE write; they do nothing against
// a compromised webview — the exact adversary image-write-wiring gates against —
// that loops `image-write` with distinct PNG-magic-prefixed random payloads.
// Each such payload content-addresses to a NEW <docFolder>/assets/ file, so the
// per-message caps are individually satisfied while the disk fills silently.
//
// This is the count/volume bound every other webview→host channel already has
// (MAX_LINT_DIAGNOSTICS etc.): a generous cumulative byte ceiling scoped to the
// editor session (one budget per panel). Once crossed it rejects further writes
// and warns the user ONCE (a per-write toast would itself be a notification-flood
// vector). Real paste flows — even bulk multi-image paste — never approach it.

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
   *  session's lifetime, no matter how many further writes are attempted. */
  reserve(byteLength: number): boolean;
}

export function createSessionVolumeBudget(
  budgetBytes: number,
  onExceeded: () => void
): SessionVolumeBudget {
  let spent = 0;
  let warned = false;
  return {
    reserve(byteLength) {
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
  };
}
