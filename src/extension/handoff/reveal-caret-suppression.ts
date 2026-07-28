// One-shot latch shared between the two handoff wirings (owned by
// QuollEditorPanel, one per panel). The ⌘⌥K context-handoff reveal
// (context-handoff-wiring.ts's revealForMention) sets a line-RANGE selection on
// a text editor via showTextDocument. The caret-handoff active-editor tracker
// (caret-handoff-wiring.ts's activeEditorSub) fires on a LATER macrotask when
// that editor becomes active and, left unguarded, applies the last-known
// COLLAPSED caret over the range — collapsing it (visible in the
// reuse-an-existing-editor path, and a fragile-timing risk for the
// insertAtMentioned read). revealForMention arm()s this before its
// showTextDocument; the tracker consume()s it (read-and-clear) on its next
// firing for the document's uri and skips the apply for THAT reveal only, so an
// ordinary Quoll→text switch afterwards still restores the caret.
//
// Deliberately a plain boolean with no disarm. The rare paths that leave an
// armed latch un-consumed — showTextDocument rejects, or resolves without making
// the doc the active editor, or an overlapping second ⌘⌥K arms while the first
// is still in flight — all degrade IDENTICALLY: the next ordinary Quoll→text
// switch consumes the stale latch and skips ONE caret restore, then self-heals.
// A disarm would close only one of those paths (reject) while adding a real
// hazard — it clears the SHARED latch, so a reject on one reveal would strip an
// overlapping sibling reveal's protection — so all three are treated uniformly
// as an accepted residual rather than special-cased. The mention delegation
// stays correct throughout: the common path is correct by construction (the
// latch skips the collapse), and the residual paths (where the latch is
// stranded) stay cosmetic because the delegated insertAtMentioned read runs
// before this later-macrotask tracker fires. Leaning on that read-before-tracker
// ordering for the common path too would be fragile — which is exactly why the
// latch exists rather than relying on the timing.
export interface RevealCaretSuppression {
  /** Arm the latch. Idempotent — arming twice before a consume stays one latch. */
  arm(): void;
  /** Read-and-clear: true exactly once per arm(), false otherwise. */
  consume(): boolean;
}

export function createRevealCaretSuppression(): RevealCaretSuppression {
  let armed = false;
  return {
    arm(): void {
      armed = true;
    },
    consume(): boolean {
      const wasArmed = armed;
      armed = false;
      return wasArmed;
    },
  };
}
