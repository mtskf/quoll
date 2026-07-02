// Single entry point for "does this markdown round-trip safely enough
// to write to disk?". The validator is framework-agnostic: it walks the
// Lezer tree (via @codemirror/lang-markdown's parser) for URL gating
// and detects leading frontmatter directly on the raw text. Zero
// runtime import of prosemirror-*: the predicate it consumes
// (isAllowedUrl) and the walker (findUnsafeUrl) survive any future
// removal of the PM schema / bridge.

import { perfNow, perfRecord } from "../shared/perf.js";
import type { MarkdownError } from "./errors.js";
import { FENCE_LINE, validateFrontmatter } from "./frontmatter.js";
import { findUnsafeUrl } from "./lezer-url-walker.js";

export type ValidateForWriteResult = { ok: true } | { ok: false; error: MarkdownError };

// Matches micromark-extension-frontmatter's opening fence: a line equal to
// `---` with optional trailing spaces/tabs and an optional CR before the line
// terminator, anchored at doc start. The closer is the shared per-line
// `FENCE_LINE` predicate (single-sourced from frontmatter.ts).
const OPENER = /^---[ \t]*\r?\n/;

// Max bytes of the underlying parser-throw message we surface in the
// user-visible toast. Anything longer is truncated; the full message
// stays in the host log channel via console.error.
const INTERNAL_ERR_MESSAGE_CAP = 200;

export function validateMarkdownForWrite(content: string): ValidateForWriteResult {
  const validateStart = QUOLL_PERF ? perfNow() : 0;
  try {
    const fmError = checkFrontmatter(content);
    if (fmError) {
      return { ok: false, error: fmError };
    }
    const urlError = findUnsafeUrl(content);
    if (urlError) {
      return { ok: false, error: urlError };
    }
    return { ok: true };
  } catch (err) {
    // Defense in depth: the Lezer parser is expected to handle any
    // input, but stack overflow on adversarially nested input or a
    // future regression could throw. Letting that propagate up through
    // decideEdit reaches onDidReceiveMessage as an unhandled exception,
    // leaving the webview with editInFlight=true and no error feedback
    // — the editor appears frozen. Converting to an error verdict
    // surfaces the failure through the normal parse-failed path.
    //
    // Sanitize the message: the user-visible toast (QuollEditorPanel's
    // showError) receives error.message verbatim. A future parser
    // version that embeds input slices in its throw message could leak
    // file content. Cap the message + log the raw error to the host
    // channel so developers retain full context without exposing user
    // bytes.
    const rawMessage = err instanceof Error ? err.message : String(err);
    const capped = rawMessage.slice(0, INTERNAL_ERR_MESSAGE_CAP);
    console.error("[quoll] validateMarkdownForWrite threw:", err);
    return {
      ok: false,
      error: {
        code: "internal_error",
        message: `Markdown validation failed: ${capped}`,
      },
    };
  } finally {
    if (QUOLL_PERF) {
      try {
        perfRecord("host:validate", perfNow() - validateStart);
      } catch {
        // Perf is dev-only and must never change the write-gate's verdict.
      }
    }
  }
}

// Detect a leading frontmatter block following micromark's rules
// (opener at doc start; close at the first subsequent bare `---` line).
// When found, validate the body via the existing brand predicate —
// this is defense in depth: under correct slicing the body cannot
// contain a bare `---` line. No closer found → not frontmatter per
// CommonMark; the doc is a `<hr>` + prose, which must round-trip.
//
// CRLF correctness: tracks line boundaries via `indexOf("\n")` instead
// of `split("\n")` so the body slice ends precisely at the closing
// fence's preceding newline regardless of `\r\n` vs `\n` line endings.
// CLOSER_LINE's `\r?$` absorbs a trailing CR inside the line content;
// the body slice's end excludes both `\r` and `\n` of the line
// terminator before the closer.
function checkFrontmatter(content: string): MarkdownError | null {
  const openerMatch = OPENER.exec(content);
  if (!openerMatch) {
    return null;
  }
  const bodyStart = openerMatch[0].length;
  let lineStart = bodyStart;
  while (lineStart <= content.length) {
    const nlIdx = content.indexOf("\n", lineStart);
    const lineEnd = nlIdx === -1 ? content.length : nlIdx;
    const line = content.slice(lineStart, lineEnd);
    if (FENCE_LINE.test(line)) {
      // Body = bytes between the opener and the line BEFORE the closer.
      // Trim a trailing `\r` (CRLF) or `\n` (LF) if present.
      let bodyEnd = lineStart;
      if (bodyEnd > bodyStart && content[bodyEnd - 1] === "\n") {
        bodyEnd -= 1;
      }
      if (bodyEnd > bodyStart && content[bodyEnd - 1] === "\r") {
        bodyEnd -= 1;
      }
      const body = content.slice(bodyStart, bodyEnd);
      if (!validateFrontmatter(body)) {
        return {
          code: "invalid_frontmatter",
          message:
            "Frontmatter body contains a bare `---` line; this would prematurely close the fence on re-parse.",
        };
      }
      return null;
    }
    if (nlIdx === -1) {
      break; // last line, no closer found
    }
    lineStart = nlIdx + 1;
  }
  // No closer — CommonMark treats this as a thematic break + prose.
  // Not frontmatter; not a write-gate concern.
  return null;
}
