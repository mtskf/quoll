// Edit lineage: "which document versions carried the text the webview's
// Edits are built on?"
//
// The reducer judges an Edit's base and a version advance by version number
// alone, but some advances do not change the text — an EOL-mode switch
// (`TextEdit.setEndOfLine`, the status bar) bumps `document.version` and
// rewrites every line ending while the text stays the same. Judged by version,
// that switch reads as a foreign edit: the epoch advances and the webview drops
// its unsent keystrokes, and an Edit built just before it is refused as stale.
//
// This records the one thing that settles it: the text the host last HANDED
// the webview (on every docVersion-carrying post) and `since`, the first label
// that carried that text. A later live text that equals it (EOL aside) is the
// same lineage — every label from `since` on is a valid base for it.
//
// Pure + vscode-free so it is unit-testable; the panel owns the instance.

import { sameTextIgnoringEol } from "../../shared/text-equality.js";

export interface EditLineage {
  /** Record the text a docVersion-carrying message was built from.
   *  `docVersion` is the label on the message; `liveVersion` is
   *  `document.version` at the time the text was read. */
  noteHandedText(text: string, docVersion: number, liveVersion: number): void;
  /** The version since which the lineage has carried `liveText`, or `null`
   *  when that cannot be proven. */
  lineageSince(liveText: string): number | null;
  /** Forget everything (e.g. after a failed read) — every query answers `null`,
   *  which is today's version-only behaviour. */
  reset(): void;
}

export function createEditLineage(): EditLineage {
  let lineage: { readonly text: string; readonly since: number } | null = null;
  return {
    noteHandedText(text, docVersion, liveVersion) {
      if (lineage !== null && sameTextIgnoringEol(text, lineage.text)) {
        // Same text handed again (a ready / visible-edge resend, or the EOL
        // switch's own form): `since` must NOT move, or an Edit built on an
        // earlier label of this very text would turn stale.
        return;
      }
      if (docVersion !== liveVersion) {
        // Different text under a label that does not describe it (a
        // rejected-draft replay re-sends the stored version while an external
        // edit is still in the documentChanged debounce). Attributing the live
        // text to a past label would let an Edit on that label overwrite the
        // external change, so leave the lineage alone: the old text no longer
        // matches live, so every query answers `null` until a Document whose
        // label really describes its text re-anchors it.
        return;
      }
      lineage = { text, since: docVersion };
    },
    lineageSince(liveText) {
      return lineage !== null && sameTextIgnoringEol(liveText, lineage.text) ? lineage.since : null;
    },
    reset() {
      lineage = null;
    },
  };
}
