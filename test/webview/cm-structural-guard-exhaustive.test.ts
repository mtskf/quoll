// @vitest-environment happy-dom
//
// The PRIMARY soundness proof for `touchesStructuralReparse`. For every single-character
// edit in the corpus that ALL of the guard's arms stay silent on, the block structure the
// bounded consumers reuse must be UNCHANGED — otherwise a record outside the recompute
// window is stranded.
//
// Identity is taken by LINE INDEX, not raw offset. Line numbering is stable across every
// edit this comparison actually reaches: a single-character edit CAN remove a newline (by
// deleting or replacing one), but that class fires NEWLINE-DELTA, so it never reaches the
// arms-silent branch below. An offset comparison
// reports every in-cell keystroke as a structural change — the contradiction that broke
// rev. 1 of the plan (Codex finding 1, Confidence 100). Line indices ask the question the
// consumers actually care about: did a block APPEAR, VANISH, or move its start/end LINE.
//
// The oracle runs on the PRODUCTION parser (`quollMarkdownLanguage()`), so a green here is
// a claim about the parser Quoll ships, not about a hand-rolled test configuration.
import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { quollMarkdownLanguage } from "../../src/webview/cm/markdown.js";
import { touchesStructuralReparse } from "../../src/webview/cm/structural-guard.js";
import { settledState } from "./helpers/settled-state.js";
import { forEachSingleCharEdit, SHAPE_CORPUS } from "./helpers/table-shape-corpus.js";

// The block node kinds the six bounded consumers key their reused records on.
const WATCHED = new Set([
  "Table",
  "Blockquote",
  "BulletList",
  "OrderedList",
  "ListItem",
  "ATXHeading1",
  "ATXHeading2",
  "ATXHeading3",
  "ATXHeading4",
  "ATXHeading5",
  "ATXHeading6",
  "SetextHeading1",
  "SetextHeading2",
  "FencedCode",
  "HTMLBlock",
  "Paragraph",
]);

function blockIdentity(doc: string): string {
  const state = settledState(EditorState.create({ doc, extensions: [quollMarkdownLanguage()] }));
  const starts = [0];
  for (let i = 0; i < doc.length; i++) {
    if (doc[i] === "\n") {
      starts.push(i + 1);
    }
  }
  const lineOf = (pos: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= pos) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo;
  };
  const out: string[] = [];
  syntaxTree(state).iterate({
    enter: (n) => {
      if (WATCHED.has(n.name)) {
        out.push(`${n.name}@L${lineOf(n.from)}-L${lineOf(Math.max(n.from, n.to - 1))}`);
      }
    },
  });
  return out.join(",");
}

/** Run the real guard over a real single-character transaction. */
function armsFire(before: string, after: string, pos: number, delLen: number, insert: string) {
  const state = settledState(
    EditorState.create({ doc: before, extensions: [quollMarkdownLanguage()] })
  );
  const tr = state.update({ changes: { from: pos, to: pos + delLen, insert } });
  void after;
  return touchesStructuralReparse(tr);
}

describe("touchesStructuralReparse — bounded-exhaustive differential oracle", () => {
  it("never stays silent on an edit that changes block identity", () => {
    let checked = 0;
    let silent = 0;
    const residual: string[] = [];
    for (const doc of SHAPE_CORPUS) {
      const before = blockIdentity(doc);
      forEachSingleCharEdit(doc, (e) => {
        const pos = firstDifference(e.before, e.after);
        const fired = armsFire(e.before, e.after, pos, e.deleted.length, e.inserted);
        checked++;
        if (fired) {
          return;
        }
        silent++;
        const after = blockIdentity(e.after);
        if (after !== before) {
          residual.push(
            `doc=${JSON.stringify(doc)} edit=${JSON.stringify(e.deleted)}->` +
              `${JSON.stringify(e.inserted)}@${pos}\n  before: ${before}\n  after:  ${after}`
          );
        }
      });
    }
    console.log(`exhaustive oracle: checked=${checked} arms-silent=${silent}`);
    expect(residual.slice(0, 5)).toEqual([]);
    // Non-vacuity: if the guard fired on EVERYTHING the comparison would be empty and a
    // broken bounded path would still be green.
    expect(silent).toBeGreaterThan(checked / 10);
  }, 600_000);
});

function firstDifference(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return i;
    }
  }
  return n;
}
