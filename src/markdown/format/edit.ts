// A replacement edit over the ORIGINAL source. Every format rule emits edits
// against original offsets; applyEdits composes them in one pass. Rules are
// designed to produce NON-OVERLAPPING edits, so an overlap is a rule bug — we
// throw rather than silently corrupt. Abutting edits (to === next.from) are
// allowed. This is the CM `ChangeSpec` shape so the webview can dispatch the
// list directly as `{ changes: edits }`.
export type Edit = { from: number; to: number; insert: string };

export function applyEdits(source: string, edits: readonly Edit[]): string {
  if (edits.length === 0) {
    return source;
  }
  const sorted = [...edits].sort((a, b) => a.from - b.from || a.to - b.to);
  let out = "";
  let cursor = 0;
  for (const e of sorted) {
    if (e.from < 0 || e.from > e.to || e.to > source.length) {
      throw new Error(
        `Format edit out of range: [${e.from}, ${e.to}) in doc of length ${source.length}`
      );
    }
    if (e.from < cursor) {
      throw new Error(
        `Format edits overlap at offset ${e.from} (previous edit ended at ${cursor})`
      );
    }
    out += source.slice(cursor, e.from) + e.insert;
    cursor = e.to;
  }
  return out + source.slice(cursor);
}
