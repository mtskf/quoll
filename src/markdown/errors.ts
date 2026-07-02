// Error types for the host-side Markdown write-gate.
//
// The write-gate (validate-for-write.ts + lezer-url-walker.ts) returns a
// discriminated `{ ok: false, error }` on rejection; `MarkdownError` is that
// payload and `MarkdownErrorCode` its closed code union. The codes are also
// mirrored on the host->webview wire (src/shared/protocol.ts) and narrowed
// back to this union by the shell (`narrowMarkdownErrorCode`); an unknown
// wire code falls back to `internal_error`, so the union can shrink safely.

/**
 * Closed union of error codes the Markdown write path can surface:
 *
 * - `unsafe_url` — a link/image destination failed the URL allowlist
 *   (lezer-url-walker.ts). Retryable by editing the source.
 * - `invalid_frontmatter` — the leading frontmatter body contains a bare
 *   `---` line that would prematurely close the fence on re-parse
 *   (validate-for-write.ts). Retryable by editing the source.
 * - `internal_error` — an unexpected invariant break in the write-gate
 *   (validate-for-write.ts). Non-retryable; report as a bug.
 */
export type MarkdownErrorCode = "unsafe_url" | "invalid_frontmatter" | "internal_error";

export interface MarkdownError {
  code: MarkdownErrorCode;
  message: string;
  detail?: Readonly<Record<string, string>>;
}
