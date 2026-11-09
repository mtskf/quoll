import type { EditorState } from "@codemirror/state";

import { htmlTableToGfm } from "./html-table-to-gfm.js";

/** Leading separator so the inserted table starts on its own line, preceded by a
 *  blank line (GFM needs the header row on a fresh line). `""` at doc start or when
 *  a blank line already precedes. */
function blockPrefix(before: string): string {
  if (before === "" || before.endsWith("\n\n")) {
    return "";
  }
  return before.endsWith("\n") ? "\n" : "\n\n";
}

/** Trailing separator so following content is not glued to the last row. */
function blockSuffix(after: string): string {
  if (after === "") {
    return "\n";
  }
  if (after.startsWith("\n\n")) {
    return "";
  }
  return after.startsWith("\n") ? "\n" : "\n\n";
}

/** Capture conversion once; frame it against the mapped replacement range. */
export function decideTablePaste(state: EditorState, html: string) {
  const gfm = htmlTableToGfm(html);
  if (gfm === null) {
    return null;
  }
  const { from, to } = state.selection.main;
  return {
    from,
    to,
    render: (live: EditorState, start: number, end: number) =>
      blockPrefix(live.doc.sliceString(0, start)) + gfm + blockSuffix(live.doc.sliceString(end)),
  };
}
