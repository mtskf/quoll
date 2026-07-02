// Fence-safety predicate for Markdown frontmatter bodies.
//
// The write-gate (`validate-for-write.ts`) and the webview line-native
// detector (`cm/frontmatter/detect.ts`) share `FENCE_LINE` as the single
// source of "is this a frontmatter fence line?" predicate. The boolean
// predicate `validateFrontmatter` is the public entry point for callers that
// need to verify a raw string before embedding it in a frontmatter block.

// A line that is exactly `---` (optionally with trailing spaces/tabs and
// an optional CR before the line terminator). Such a line, if it appears
// inside a serialized frontmatter body, would close the `---\n...\n---`
// fence prematurely on re-parse — the write-gate therefore rejects it. The
// `\r?` makes CRLF behaviour explicit; the previous `\s*` form happened
// to match CRLF but also allowed unrelated whitespace classes.
const BARE_FENCE_LINE = /^---[ \t]*\r?$/m;

/**
 * A single line that is exactly `---` (optional trailing spaces/tabs + optional
 * CR). The SINGLE source of the "is this a frontmatter fence line?" predicate,
 * shared by the host write-gate (`validate-for-write.ts`) and the webview
 * line-native detector (`cm/frontmatter/detect.ts`). Differs from
 * `BARE_FENCE_LINE` above only in flags: this is the per-line `.test` variant
 * (no `/m`); `BARE_FENCE_LINE` is the multiline body-scan variant used by
 * `validateFrontmatter`. `\r?` keeps CRLF explicit for the write-gate (which
 * sees real `\r\n`); CodeMirror line text never carries a `\r`, so the `\r?`
 * is inert there.
 */
export const FENCE_LINE = /^---[ \t]*\r?$/;

/**
 * Validate whether `raw` is safe to use as opaque frontmatter. Returns
 * `false` when `raw` contains a bare `---` line (with optional trailing
 * spaces/tabs and optional CR) that would prematurely close the re-emitted
 * fence.
 *
 * @example
 *   const userInput: string = readUserMetadata();
 *   if (validateFrontmatter(userInput)) {
 *     // safe to embed as frontmatter body
 *   } else {
 *     surfaceUserError("Invalid frontmatter: contains a `---` line");
 *   }
 */
export function validateFrontmatter(raw: string): boolean {
  return !BARE_FENCE_LINE.test(raw);
}
