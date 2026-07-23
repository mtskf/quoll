// Pure detection for workspace-relative code references. The host RE-VALIDATES
// the resulting path independently — this output is never trusted.

import { isAllowedUrl } from "../../../markdown/url-allowlist.js";
import { MAX_CODE_REFERENCE_LINE, MAX_HREF_LENGTH } from "../../../shared/protocol.js";

export type CodeReference = { path: string; line?: number; col?: number };
export type ParseCodeReferenceOptions = { requirePathSeparator: boolean };

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const LINE_COL_SUFFIX_RE = /:(\d+)(?::(\d+))?$/;

function inRange(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= MAX_CODE_REFERENCE_LINE;
}

export function parseCodeReference(
  text: string,
  opts: ParseCodeReferenceOptions
): CodeReference | null {
  const s = text.trim();
  if (s === "" || /\s/.test(s)) {
    return null;
  }
  let path = s;
  let line: number | undefined;
  let col: number | undefined;
  const suffix = LINE_COL_SUFFIX_RE.exec(s);
  if (suffix !== null) {
    const l = Number.parseInt(suffix[1], 10);
    const c = suffix[2] !== undefined ? Number.parseInt(suffix[2], 10) : undefined;
    if (!inRange(l) || (c !== undefined && !inRange(c))) {
      return null;
    }
    path = s.slice(0, suffix.index);
    line = l;
    col = c;
  }
  if (path === "" || SCHEME_RE.test(path) || path.startsWith("/") || path.includes("\\")) {
    return null;
  }
  if (opts.requirePathSeparator && !path.includes("/")) {
    return null;
  }
  const ref: CodeReference = { path };
  if (line !== undefined) {
    ref.line = line;
  }
  if (col !== undefined) {
    ref.col = col;
  }
  return ref;
}

/** The inline-code surface gate: a path-separated, non-.md, allowlist-safe,
 *  length-bounded reference. Decoration + click handler both call this. */
export function parseInlineCodeReference(text: string): CodeReference | null {
  const ref = parseCodeReference(text, { requirePathSeparator: true });
  if (ref === null) {
    return null;
  }
  if (/\.md$/i.test(ref.path) || !isAllowedUrl(ref.path) || ref.path.length > MAX_HREF_LENGTH) {
    return null;
  }
  return ref;
}
