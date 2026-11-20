// INPUT ASSUMPTION: `source` is LF-normalized. The sole caller is the webview,
// whose `doc.toString()` always joins with LF (CM's internal representation),
// so this holds. Raw CRLF text is NOT supported — @lezer/markdown emits no
// Table nodes for CRLF-joined input; a future host-side caller must LF-normalize
// (or map offsets) before calling. The per-row table model still preserves each
// row's own CRLF lineEnding verbatim, so LF-in / mixed-ending round-trips.
import { bulletUnifyEdits } from "./bullet-rules.js";
import { applyEdits, type Edit } from "./edit.js";
import { lineEdits } from "./line-planner.js";
import { listRenumberEdits } from "./list-rules.js";
import { classifyDocument } from "./segment.js";
import { tableEdits } from "./table-format.js";

/** `maxLength` caps the formatted document, in units of `measure` (default:
 *  UTF-16 length; the caller passes its outbound length). It is judged on the net
 *  growth of ALL rules, and a table set whose growth exceeds what is left of the
 *  budget throws `FormatTooLargeError` before any padding is rendered. A document
 *  that does not grow never throws; the caller's final size check is the backstop. */
export function formatDocumentEdits(
  source: string,
  maxLength = Number.POSITIVE_INFINITY,
  measure: (text: string) => number = (text) => text.length
): Edit[] {
  if (source.length === 0) {
    return [];
  }
  const { protectedRanges, tableRanges, literalSpans, orderedLists, bulletLists } =
    classifyDocument(source);
  const keepOut = [...protectedRanges, ...tableRanges];
  // Sort into document order: the runtime path dispatches `{ changes: edits }`
  // directly, and CM expects changes in order. This is the ONE sort — applyEdits
  // (used to validate + string-apply) also sorts, so both consume identical
  // document-ordered, non-overlapping edits.
  const otherEdits = [
    ...listRenumberEdits(orderedLists),
    ...bulletUnifyEdits(source, bulletLists),
    ...lineEdits(source, keepOut, literalSpans),
  ];
  let tableBudget = Number.POSITIVE_INFINITY;
  if (Number.isFinite(maxLength)) {
    const otherGrowth = otherEdits.reduce(
      (sum, e) => sum + measure(e.insert) - measure(source.slice(e.from, e.to)),
      0
    );
    tableBudget = maxLength - measure(source) - otherGrowth;
  }
  return [...tableEdits(source, tableRanges, tableBudget), ...otherEdits].sort(
    (a, b) => a.from - b.from || a.to - b.to
  );
}

export function formatDocument(source: string): string {
  return applyEdits(source, formatDocumentEdits(source));
}
