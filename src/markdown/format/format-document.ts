// INPUT ASSUMPTION: `source` is LF-normalized. The sole caller is the webview,
// whose `doc.toString()` always joins with LF (CM's internal representation),
// so this holds. Raw CRLF text is NOT supported — @lezer/markdown emits no
// Table nodes for CRLF-joined input; a future host-side caller must LF-normalize
// (or map offsets) before calling. The per-row table model still preserves each
// row's own CRLF lineEnding verbatim, so LF-in / mixed-ending round-trips.
import { applyEdits, type Edit } from "./edit.js";
import { lineEdits } from "./line-planner.js";
import { listRenumberEdits } from "./list-rules.js";
import { classifyDocument } from "./segment.js";
import { tableEdits } from "./table-format.js";

export function formatDocumentEdits(source: string): Edit[] {
  if (source.length === 0) {
    return [];
  }
  const { protectedRanges, tableRanges, orderedLists } = classifyDocument(source);
  const keepOut = [...protectedRanges, ...tableRanges];
  // Sort into document order: the runtime path dispatches `{ changes: edits }`
  // directly, and CM expects changes in order. This is the ONE sort — applyEdits
  // (used to validate + string-apply) also sorts, so both consume identical
  // document-ordered, non-overlapping edits.
  return [
    ...tableEdits(source, tableRanges),
    ...listRenumberEdits(orderedLists),
    ...lineEdits(source, keepOut),
  ].sort((a, b) => a.from - b.from || a.to - b.to);
}

export function formatDocument(source: string): string {
  return applyEdits(source, formatDocumentEdits(source));
}
