// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTreeAvailable } from "@codemirror/language";
import {
  EditorSelection,
  EditorState,
  type Extension,
  type SelectionRange,
} from "@codemirror/state";
import type { DecorationSet, WidgetType } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { imageBlockField } from "../../src/webview/cm/image/index.js";
import { settledState } from "./helpers/settled-state.js";
import { settledMount } from "./helpers/settled-view.js";

interface Slot {
  from: number;
  to: number;
  widget: WidgetType;
}
function slots(set: DecorationSet): Slot[] {
  const out: Slot[] = [];
  const iter = set.iter();
  while (iter.value !== null) {
    out.push({ from: iter.from, to: iter.to, widget: iter.value.spec.widget as WidgetType });
    iter.next();
  }
  return out;
}
// `expectedSlots` is per-row on purpose. Comparing actual to oracle is vacuous when BOTH
// are empty, and a field-wide break that emptied imageBlockField would leave the whole
// table green; but a blanket "non-empty" pin would be wrong too — the "G1 merge" row
// legitimately ends at zero standalone widgets (the image is demoted to inline). Only the
// per-row count distinguishes "this row's expected shape" from "the field stopped working".
function assertEquivalent(actual: Slot[], oracle: Slot[], expectedSlots: number): void {
  expect(oracle).toHaveLength(expectedSlots);
  expect(actual.map((s) => ({ from: s.from, to: s.to }))).toEqual(
    oracle.map((s) => ({ from: s.from, to: s.to }))
  );
  for (let i = 0; i < oracle.length; i++) {
    expect(actual[i].widget.eq(oracle[i].widget)).toBe(true); // pins docFrom/slice
  }
}
const exts = (): Extension[] => [
  EditorState.allowMultipleSelections.of(true),
  markdown({ base: markdownLanguage }),
  imageBlockField,
];

interface Edit {
  changes?: { from: number; to?: number; insert?: string };
  selection?: SelectionRange | EditorSelection;
  cursorAtEnd?: boolean; // resolve to cursor(doc.length) AFTER the change (avoids RangeError)
}

// Where the settles go, and — just as load-bearing — where they do NOT.
//
// The MOUNT settles: imageBlockField.create() reads syntaxTree(state) (image-field.ts),
// so on a truncated init snapshot the field's INITIAL value is built over a partial tree
// and the first edit's bounded path starts from a wrong `prev`. A bare ensureSyntaxTree
// cannot fix that — it advances the parse CONTEXT and leaves the field's published
// SNAPSHOT alone. Settling here precedes every edit, so it vacates nothing.
//
// The ORACLE settles: that is what makes `want` the true full-recompute result. It also
// removes a live vacuity — assertEquivalent([], []) passes when BOTH sides are truncated
// to nothing, which is exactly what two bare ensureSyntaxTree calls used to produce.
//
// The EDIT LOOP must NOT settle. `forceParsing` dispatches whenever the completed tree
// differs from the published snapshot, and that dispatch drives imageBlockField.update's
// tree-identity branch into computeFreshFull — silently turning this bounded-vs-full
// compare into full-vs-full. That trades a flake for a vacuous pass, which is worse.
// The pin below is what keeps the bounded result trustworthy without a settle.
//
// ⚠️ The comparison is ATTEMPTED rather than asserted on the first try. CodeMirror gives its
// post-edit reparse a 20ms WALL-CLOCK budget, and under CPU starvation that window can
// elapse while this process is descheduled; image-field.ts's G2 arm then self-heals with a
// full recompute, so the bounded path is not what ran and there is nothing to compare.
// Retrying from a fresh view neither hides a regression (a real bounded bug reds every
// attempt that gets far enough to compare — measured by breaking computeBounded) nor passes
// vacuously (an all-starved run throws below), which a vitest-level `{ retry: n }` would
// fail on both counts.
function checkEquivalence(initial: string, edits: Edit[], oracleSlots: number): void {
  if (edits.length === 0) {
    // The gate inside the attempt is per-`Edit`, so a zero-edit call would compare a
    // settled mount against a settled oracle and report success having exercised no
    // bounded path. Refuse it at the door rather than let it read as a passing
    // equivalence case, exactly as cm-decoration-callout-marker-conceal.test.ts does.
    throw new Error("checkEquivalence: at least one edit is required to exercise the bounded path");
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    if (runOnce()) {
      return;
    }
  }
  throw new Error(
    "checkEquivalence: no attempt reached a complete post-edit frontier, so nothing was compared"
  );

  /** One attempt. Returns false when the frontier was starved and nothing was compared. */
  function runOnce(): boolean {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = settledMount(
      { state: EditorState.create({ doc: initial, extensions: exts() }), parent },
      10_000
    );
    try {
      for (const e of edits) {
        view.dispatch({ changes: e.changes, selection: e.selection });
        if (e.cursorAtEnd) {
          view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
        }
        // Anti-masking gate, once per `Edit` — which on a `cursorAtEnd` row is after TWO
        // dispatches, not one. (The sibling in cm-decoration-callout-marker-conceal.test.ts
        // says "per-dispatch" because there an `Edit` IS exactly one dispatch.) That is
        // equivalent here only because the extra dispatch is SELECTION-ONLY: LanguageState
        // .apply returns the same LanguageState on a non-docChanged transaction, so it
        // cannot advance `isDone` and mask a starved doc-changing dispatch.
        // ⚠️ Adding a second DOC-CHANGING dispatch to this loop would break that, and the
        // gate would then have to be split to run after each one. syntaxTreeAvailable reads
        // the parse CONTEXT's `isDone`, which reflects only the LAST apply — outside this
        // loop a starved intermediate edit would take image-field.ts's G2 computeFreshFull
        // arm unobserved behind a later completing edit.
        //
        // ⚠️ What a `true` rules out is the STARVED-frontier full walk, and nothing more.
        // imageBlockField.update takes its G3 arm — computeFreshFull — whenever
        // leadingFrontmatterEnd changes, BEFORE this predicate is ever consulted
        // (image-field.ts), so `true` does not mean the bounded path ran. The "G3
        // frontmatter length shift" row below takes that arm, and what it compares there is
        // the field's INCREMENTALLY parsed full walk against the oracle's freshly parsed
        // one — not bounded against full. (Measured 2026-09-02: deleting the G3 arm leaves
        // every row here green, so this table does not pin that guard either way.) A false
        // means the frontier was starved, so abandon the attempt instead of comparing a
        // full walk over a PARTIAL tree against the settled oracle.
        if (!syntaxTreeAvailable(view.state, view.state.doc.length)) {
          return false;
        }
      }
      const oracle = settledState(
        EditorState.create({
          doc: view.state.doc.toString(),
          selection: view.state.selection,
          extensions: exts(),
        })
      );
      assertEquivalent(
        slots(view.state.field(imageBlockField)),
        slots(oracle.field(imageBlockField)),
        oracleSlots
      );
      return true;
    } finally {
      view.destroy();
      parent.remove();
    }
  }
}

const IMG = "![alt](https://example.com/a.png)";

describe("imageBlockField bounded ≡ full", () => {
  // `oracleSlots` is the widget count the settled oracle must hold AFTER the edits —
  // measured, not guessed. See assertEquivalent for why a per-row count and not a blanket
  // non-empty pin.
  const cases: Array<{ name: string; initial: string; edits: Edit[]; oracleSlots: number }> = [
    {
      name: "type prose far from an image",
      initial: `# Top\n\nprose\n\n${IMG}\n\nmore`,
      edits: [{ changes: { from: 2, insert: "x" }, selection: EditorSelection.cursor(3) }],
      oracleSlots: 1,
    },
    {
      name: "introduce a standalone image from scratch",
      initial: "plain text\n",
      edits: [{ changes: { from: 0, to: 10, insert: IMG }, cursorAtEnd: true }],
      oracleSlots: 1,
    },
    {
      name: "insert an image before an existing one",
      initial: `${IMG}\n\n${IMG}\n`,
      edits: [{ changes: { from: 0, insert: `${IMG}\n\n` }, cursorAtEnd: true }],
      oracleSlots: 3,
    },
    {
      name: "edit the url inside an image",
      initial: `${IMG}\n\nbelow`,
      edits: [{ changes: { from: 20, insert: "z" }, cursorAtEnd: true }],
      oracleSlots: 1,
    },
    {
      name: "delete an image",
      initial: `${IMG}\n\nmid\n\n${IMG}\n`,
      edits: [{ changes: { from: 0, to: IMG.length + 1 }, cursorAtEnd: true }],
      oracleSlots: 1,
    },
    // G1: blank-line toggle ADJACENT to the image flips standalone eligibility
    // without touching the image's bytes.
    {
      name: "G1 split: blank line above promotes image to standalone",
      initial: `prose\n${IMG}\n`,
      edits: [{ changes: { from: 5, insert: "\n" }, cursorAtEnd: true }],
      oracleSlots: 1,
    },
    {
      name: "G1 merge: delete blank line above demotes image",
      initial: `prose\n\n${IMG}\n`,
      edits: [{ changes: { from: 5, to: 6 }, cursorAtEnd: true }],
      oracleSlots: 0, // the demoted image is inline, so ZERO standalone widgets is the answer
    },
    {
      name: "G1 below: blank line below promotes image",
      initial: `${IMG}\ntext\n`,
      edits: [{ changes: { from: IMG.length, insert: "\n" }, cursorAtEnd: true }],
      oracleSlots: 1,
    },
    {
      name: "G3 frontmatter length shift before image",
      initial: `---\ntitle: a\n---\n\n${IMG}\n`,
      edits: [{ changes: { from: 11, insert: "bb" }, cursorAtEnd: true }],
      oracleSlots: 1,
    },
    {
      name: "multi-cursor far apart",
      initial: `${IMG}\n\nprose one\n\n${IMG}\n\ntail`,
      edits: [
        {
          changes: { from: IMG.length + 3, insert: "q" },
          selection: EditorSelection.create([
            EditorSelection.cursor(IMG.length + 4),
            EditorSelection.cursor(0),
          ]),
        },
      ],
      oracleSlots: 1, // two images, but the cursor at 0 reveals the first one
    },
    {
      name: "selection-only onto then off an image",
      initial: `${IMG}\n\nbelow text`,
      edits: [{ selection: EditorSelection.cursor(3) }, { selection: EditorSelection.cursor(40) }],
      oracleSlots: 1,
    },
  ];
  for (const c of cases) {
    it(c.name, () => checkEquivalence(c.initial, c.edits, c.oracleSlots));
  }
});
