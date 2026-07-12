// Pure decision + shared copy for the dirty-doc on-disk-divergence conflict
// prompt. Host-independent (no `vscode` import) so it is unit-testable and the
// e2e / panel share ONE definition of the button labels.
//
// Why a dedicated module: VS Code auto-reverts a CLEAN externally-changed
// TextDocument but SKIPS reverting a DIRTY model to protect unsaved edits (see
// LEARNING.md "2026-07-04: 外部ディスク編集…dirty ドキュメント"). The dirty
// case therefore needs an explicit divergence check + user-confirmed reload;
// this module owns the "should we even prompt" predicate.

export const DISK_CONFLICT_MESSAGE =
  "This file changed on disk while you have unsaved changes in Quoll.";
export const DISK_CONFLICT_RELOAD = "Reload from disk";
export const DISK_CONFLICT_KEEP = "Keep my edits";

// Normalize away the two differences VS Code silently erases when it loads a
// file, so neither raises a spurious content conflict:
//   - a leading UTF-8 BOM (stripped on load; disk bytes decoded raw keep it)
//   - EOL flavour (CRLF/CR → LF; getText() is uniform per document.eol)
// The BOM is matched by code point (0xFEFF) rather than a literal character so
// no invisible glyph lives in the source.
function normalizeText(text: string): string {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return withoutBom.replace(/\r\n|\r/g, "\n");
}

// Prompt ONLY when the buffer is dirty AND the on-disk content genuinely
// diverges from the in-memory buffer. This is a DECODED-content diff (not a raw
// byte compare): BOM-only and EOL-only differences never prompt, matching how
// VS Code normalizes both on load.
export function shouldPromptDiskConflict(
  isDirty: boolean,
  diskText: string,
  bufferText: string
): boolean {
  return isDirty && normalizeText(diskText) !== normalizeText(bufferText);
}
