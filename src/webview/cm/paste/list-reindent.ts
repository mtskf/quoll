// Paste re-indent: when the clipboard carries a MULTI-LINE plain-text Markdown
// LIST fragment and the caret sits at the start of a line inside an existing
// list context, re-base the fragment's leading indentation so its top level
// aligns with the caret's column, preserving the fragment's inner relative
// structure (Obsidian analogue). Pure text transform on the paste content; the
// handler (below) inserts it through the normal edit pipeline. Every
// non-qualifying paste defers (return null / false) so the other paste handlers
// + CM's default plain-text paste still run.
//
// v1 is deliberately conservative — "never corrupt" beats "re-base everything":
// a fragment containing a fenced code block, tabs in its indentation, a
// non-list first line, or a non-list line shallower than the list markers is
// DEFERRED (inserted unchanged), because re-basing those cases could corrupt
// the Markdown. Re-basing around a preserved fence is future work.

import { type Extension, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { columnAt } from "../list/list-geometry.js";
import { parseListMark } from "../list/list-transform.js";
import { caretInCode, listItemAt } from "../list/list-tree.js";

/** Leading-whitespace column of `line`, expanding tabs to `tabSize`, whether that
 *  whitespace contains a tab (a tab in indentation makes the re-base ambiguous —
 *  the caller defers), and the byte length of the run (so the caller can splice
 *  the post-indent remainder). */
function leadingIndent(
  line: string,
  tabSize: number
): { col: number; len: number; hasTab: boolean } {
  let col = 0;
  let i = 0;
  let hasTab = false;
  while (i < line.length) {
    const ch = line.charCodeAt(i);
    if (ch === 0x20) {
      col += 1;
    } else if (ch === 0x09) {
      col += tabSize - (col % tabSize);
      hasTab = true;
    } else {
      break;
    }
    i++;
  }
  return { col, len: i, hasTab };
}

/** A fence delimiter line: >=3 backticks or tildes after any leading whitespace.
 *  Matched conservatively (over-detection only DEFERS, which is safe) so no fence
 *  lexer state machine is needed — a fence-bearing fragment is left unchanged. */
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

/** Is `line` (after leading whitespace) the start of a CommonMark list item? The
 *  marker token is the first whitespace-free run; `parseListMark` decides bullet
 *  (`-`/`*`/`+`) vs ordered (`\d{1,9}[.)]`). */
function isListLine(line: string): boolean {
  const trimmed = line.trimStart();
  const token = /^(\S+)(?:\s|$)/.exec(trimmed);
  return token !== null && parseListMark(token[1]) !== null;
}

/**
 * Re-base a pasted list fragment's indentation so its top level sits at
 * `destColumn`, or return `null` to defer (single-line / not a clean list
 * fragment / fence-bearing / tab-ambiguous / shallower non-marker line).
 * `delta === 0` still returns the (unchanged) text so the handler's
 * prefix-swallow runs. `tabSize` expands leading tabs when measuring columns.
 */
export function reindentPastedList(
  text: string,
  destColumn: number,
  tabSize: number
): string | null {
  const hadTrailingNewline = text.endsWith("\n");
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (hadTrailingNewline) {
    lines.pop(); // drop the empty element the trailing newline produces
  }
  if (lines.length < 2) {
    return null; // single-line → not a multi-line fragment
  }

  let firstNonBlank = -1;
  let markerMin = Number.POSITIVE_INFINITY; // min indent among list-marker lines
  let nonMarkerMin = Number.POSITIVE_INFINITY; // min indent among other content lines
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      return null; // fence-bearing fragment → defer unchanged (byte-identical)
    }
    if (line.trimStart() === "") {
      continue; // blank line: no indent contribution
    }
    const { col, hasTab } = leadingIndent(line, tabSize);
    if (hasTab) {
      return null; // tab in indentation → ambiguous, defer
    }
    if (firstNonBlank === -1) {
      firstNonBlank = i;
    }
    if (isListLine(line)) {
      if (col < markerMin) {
        markerMin = col;
      }
    } else if (col < nonMarkerMin) {
      nonMarkerMin = col;
    }
  }

  // The fragment must OPEN with a list item (line 0 non-blank + a marker). A
  // leading blank line (`firstNonBlank > 0`) is not a clean list block — and the
  // prefix-swallow would silently de-indent that leading blank — so defer.
  if (firstNonBlank !== 0 || !isListLine(lines[0])) {
    return null;
  }
  if (nonMarkerMin < markerMin) {
    return null; // a non-list line is shallower than the list → ambiguous base
  }

  // NOTE: delta === 0 is NOT a defer — the text is still re-emitted so the
  // handler's prefix-swallow runs (deferring would double-indent the first line).
  const delta = destColumn - markerMin;
  const out: string[] = [];
  for (const line of lines) {
    if (line.trimStart() === "") {
      out.push(line); // blank: leave as-is (no injected indent)
      continue;
    }
    const { col, len } = leadingIndent(line, tabSize);
    const newCol = col + delta;
    // Fail-closed insurance (checked BEFORE `" ".repeat`, which throws on a
    // negative count): `markerMin` is the global min of qualifying lines, so
    // `newCol >= destColumn >= 0` always holds — but defer if it is ever violated.
    if (newCol < 0) {
      return null;
    }
    out.push(" ".repeat(newCol) + line.slice(len));
  }

  return out.join("\n") + (hadTrailingNewline ? "\n" : "");
}

/** Only SPACES between the line start and `pos`? (i.e. the caret sits in the
 *  line's leading indentation, indented with spaces — pasting at line start). A
 *  tab is rejected: the prefix is swallowed and re-emitted as spaces, so a tab
 *  here would silently rewrite the document's tab indentation to spaces. */
function prefixIsSpacesOnly(prefix: string): boolean {
  return /^ *$/.test(prefix);
}

export function listReindentPaste(opts: { canWrite: () => boolean }): Extension {
  return Prec.high(
    EditorView.domEventHandlers({
      paste: (event, view) => {
        const text = event.clipboardData?.getData("text/plain");
        if (!text?.includes("\n")) {
          return false; // no text flavour / single-line → defer
        }
        const { state } = view;
        const { from, empty } = state.selection.main;
        // Empty selection only: a non-empty (possibly reverse) selection has an
        // ambiguous caret and would make the [line.from, from) replace cross
        // selected text. Defer to default paste.
        if (!empty) {
          return false;
        }
        const line = state.doc.lineAt(from);
        // Only paste-at-line-start is safe: a non-spaces prefix would glue a
        // pasted marker mid-line, and a tab prefix would be rewritten to spaces.
        if (!prefixIsSpacesOnly(state.doc.sliceString(line.from, from))) {
          return false;
        }
        // Must be an existing list context (spec), and never inside code.
        if (caretInCode(state, from) || listItemAt(state, from) === null) {
          return false;
        }
        const destColumn = columnAt(state, from);
        const rebased = reindentPastedList(text, destColumn, state.tabSize);
        if (rebased === null) {
          return false; // not a clean list fragment / ambiguous → default paste
        }
        // preventDefault ONLY here, AFTER committing to the re-base (mirrors
        // htmlTablePaste): moving it earlier would swallow non-qualifying pastes.
        event.preventDefault();
        // Read-only: swallow silently with NO fallback insert. canWrite() is the
        // same source that drives EditorState.readOnly, so they cannot diverge.
        if (!opts.canWrite()) {
          return true;
        }
        // Replace from the LINE START (swallowing the spaces prefix) so the
        // transform's absolute indentation is not double-counted with the prefix.
        view.dispatch({
          changes: { from: line.from, to: from, insert: rebased },
          selection: { anchor: line.from + rebased.length },
          scrollIntoView: true,
          userEvent: "input.paste",
        });
        return true;
      },
    })
  );
}
