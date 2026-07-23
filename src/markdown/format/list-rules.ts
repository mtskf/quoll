// Ordered-list renumbering. Render-identical: an ordered list's output depends
// only on its FIRST item's number (the `start`), so renumbering the remainder
// cannot change rendering — PROVIDED the marker width is unchanged. A width
// change (e.g. 9. -> 10.) widens the content column and de-nests indented
// children, so a group with any width-changing item is left untouched.
import type { Edit } from "./edit.js";
import type { OrderedList } from "./segment.js";

const ORDERED = /^(\d+)([.)])$/;

export function listRenumberEdits(orderedLists: readonly OrderedList[]): Edit[] {
  const edits: Edit[] = [];
  for (const list of orderedLists) {
    const first = ORDERED.exec(list.marks[0]?.text ?? "");
    if (!first) {
      continue;
    }
    const start = Number.parseInt(first[1], 10);
    const delim = first[2];
    const targets = list.marks.map((m, i) => {
      const parsed = ORDERED.exec(m.text);
      return parsed ? `${start + i}${delim}` : m.text;
    });
    // Width-stable guard: bail the whole group if any marker changes length.
    if (list.marks.some((m, i) => targets[i].length !== m.text.length)) {
      continue;
    }
    list.marks.forEach((m, i) => {
      if (targets[i] !== m.text) {
        edits.push({ from: m.from, to: m.to, insert: targets[i] });
      }
    });
  }
  return edits;
}
