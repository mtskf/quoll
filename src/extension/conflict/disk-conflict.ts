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

// Decode on-disk bytes to text ONLY when they are unambiguously UTF-8 we can
// faithfully compare against the (VS-Code-decoded) in-memory buffer; return
// null otherwise. VS Code 1.94 exposes no decode/encoding API, so a document
// opened under a non-UTF-8 files.encoding (Shift-JIS, UTF-16) would mojibake if
// we decoded its bytes as UTF-8 — making diskText !== bufferText ALWAYS true and
// firing a spurious conflict prompt on every external touch. Rather than guess an
// encoding we cannot read, we treat non-UTF-8 BYTES as "not comparable" and the
// caller skips the prompt. This covers files whose bytes are not UTF-8; it does
// NOT cover a valid-UTF-8 file that VS Code was told to decode as another encoding
// via files.encoding (its buffer mojibakes while the bytes decode cleanly here) —
// that residual spurious prompt is unreachable without the 1.94-absent encoding
// API. In every case the code never SILENTLY discards edits — the worst outcome
// is a spurious "This file changed on disk" prompt the user can decline via
// "Keep my edits" (accepting it is a user-confirmed revert, not silent loss).
//
//   - fatal TextDecoder throws on invalid UTF-8 (Shift-JIS multibyte, a UTF-16
//     BOM's 0xFF/0xFE lead) → null.
//   - a decoded NUL betrays a non-UTF-8 text encoding read byte-wise (BOM-less
//     UTF-16 of ASCII decodes to valid-but-wrong UTF-8 with interleaved NULs).
//     Markdown text never contains NUL → treat as untrusted → null.
//   - the default (ignoreBOM:false) decoder strips a leading UTF-8 BOM, matching
//     how VS Code normalizes it on load (normalizeText also strips it downstream,
//     so the two stay consistent).
export function decodeComparableUtf8(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (text.includes("\u0000")) {
    return null;
  }
  return text;
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
