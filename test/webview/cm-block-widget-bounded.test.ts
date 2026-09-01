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

// The two ways a `changes` object normalises to an empty ChangeSet are pinned directly by
// the door-guard test below (`{ changes: { from: 0 } }` and `{ changes: { from: 0, to: 0 } }`,
// with and without an explicit `insert: ""`), not restated here. An inert `changes` alone
// only kills imageBlockField.update's docChanged arm (image-field.ts:272) — paired with a
// real `selection` on the same `Edit`, it can still reach `computeBounded` through the
// selection arm (image-field.ts:284); the door guard below requires `!e.selection` too.
const inertChanges = (c: Edit["changes"]) =>
  c !== undefined && !c.insert && (c.to === undefined || c.to === c.from);

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
  if (
    edits.every((e) => (!e.changes || inertChanges(e.changes)) && !e.selection && !e.cursorAtEnd)
  ) {
    // What this rules out: the ALL-inert call — every edit in the array has no `changes` (or
    // a `changes` object that normalises to an empty ChangeSet, per `inertChanges` above), no
    // `selection`, and no `cursorAtEnd` (`[]`, `[{}]`, an array of empty-object `Edit`s). Only
    // then is every dispatch below a literal no-op, so comparing the settled mount against the
    // settled oracle would report success having exercised no bounded path. The predicate is
    // `.every(...)`, so a MIXED array — even one live edit among otherwise-inert ones — passes
    // the door; that is deliberate, since one live edit is enough for the comparison below to
    // be ABLE to exercise a bounded arm. Whether it actually does is decided downstream, by
    // image-field.ts's own gates — see "What this does NOT rule out" below.
    // What this does NOT rule out: a `selection`/`cursorAtEnd` edit that dispatches something
    // real but whose selection LINE SPAN happens not to change. On a non-docChanged
    // transaction, reaching image-field.ts's `computeBounded` requires first surviving its G3
    // frontmatter check (:269) and its tree-identity check (:278), and only then finding
    // `!selectionLineSpansEqual(tr.startState, tr.state)` (:281) — so that inequality is a
    // NECESSARY condition for the bounded arm, not a sufficient one, and deciding it at the
    // door would mean reimplementing all three checks here (none are exported from
    // image-field.ts). Unlike the `changes` shape above — which `inertChanges` decides from
    // the `Edit` literal alone — whether a selection move crosses a line boundary depends on
    // both transaction states, which this predicate does not have. So this guard is a floor,
    // not a guarantee: it catches the fully inert call, not every selection-only call that
    // fails to cross a line boundary. The "selection-only onto then off an image" case below
    // is deliberately NOT inert — moving the cursor onto and then off the image's line
    // crosses that boundary and exercises computeBounded via the selection arm, not the
    // docChanged one.
    throw new Error(
      "checkEquivalence: at least one edit with `changes`, `selection`, or `cursorAtEnd` is required to exercise the bounded path"
    );
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
        // dispatches, not one. (The sibling in
        // decorations/cm-decoration-callout-marker-conceal.test.ts says "per-dispatch"
        // because there an `Edit` IS exactly one dispatch.)
        //
        // Operating rule for this loop: nothing may sit between any two of the dispatches
        // this loop performs — within a `cursorAtEnd` pair AND across iterations, since the
        // gate read right below is itself inside that window — that advances the parse or
        // publishes a tree: no settle, no parse-advancing read (ensureSyntaxTree, a
        // `fullTree` probe, forceParsing, …), no second doc-changing dispatch, and no `await`
        // or timer flush that yields to the event loop. The gate's no-op guarantee depends on
        // this loop staying straight-line synchronous code end to end; break that shape and
        // the guarantee breaks with it.
        //
        // ⚠️ What a `true` rules out is the STARVED-frontier full walk, and nothing more.
        // imageBlockField.update takes its G3 arm — computeFreshFull — whenever
        // leadingFrontmatterEnd changes, BEFORE this predicate is ever consulted
        // (image-field.ts), so `true` does not mean the bounded path ran. The seven "G3"
        // rows below take that arm, and what they compare there is the field's INCREMENTALLY
        // parsed full walk against the oracle's freshly parsed one — not bounded against
        // full. That is not a hole: it is how those rows pin the arm, since with the arm
        // deleted the bounded path runs INSTEAD and gets the answer wrong. But only the six
        // BOUNDARY-CROSSING rows do that pinning — the two closer-fence ones, the two opener
        // ones, and the two closer-existence ones; the "frontmatter length shift" row stays
        // green either way (measured 2026-09-02, all claims). A false means the frontier was
        // starved, so abandon the attempt instead of comparing a full walk over a PARTIAL
        // tree against the settled oracle.
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

// The two G3 CLOSER-FENCE boundary-crossing rows below share one document pair (the
// opener-flip pair further down, and the closer-existence pair further down still, are
// the other two directions of the same arm), and the pair is written as offsets off these
// constants rather than as literal numbers so renaming the body key cannot silently point
// the edit at the wrong line. `FM_OPEN` is exactly the opener line plus the one body line,
// so `FM_OPEN.length` IS line 2's `to`; `FENCE` is the closer line with its preceding
// newline, so inserting it there ADDS a closer at line 3 and deleting
// `[FM_OPEN.length, FM_OPEN.length + FENCE.length)` REMOVES it again.
const FM_OPEN = "---\ntitle: a";
const FENCE = "\n---";
// EXPOSED closes the fence at line 3, so the image below it sits outside the frontmatter
// and renders as a widget. ENCLOSED has no closer until the `---` BELOW the image, so
// leadingFrontmatterEnd swallows the image and it stays raw source. Each doc is the other's
// post-edit result, which is what lets one pair cover both directions of the crossing.
const G3_IMAGE_EXPOSED = `${FM_OPEN}${FENCE}\n\nintro\n\n${IMG}\n\n---\n\nbody`;
const G3_IMAGE_ENCLOSED = `${FM_OPEN}\n\nintro\n\n${IMG}\n\n---\n\nbody`;

// The OPENER pair. `detect.ts` starts with an O(1) reject — line 1 must itself be a fence —
// so a document's frontmatter can also appear and vanish without any closer moving, and
// that trigger is invisible to a comparison that only looks at where the CLOSER sits. These
// two docs differ by exactly one dash at offset 0, written as a prefix off the other so the
// "one dash on line 1, nothing else" invariant is textual rather than a promise in a
// comment: prepending it IS the edit, and deleting `[0, 1)` is its inverse.
//
// The image sits in its OWN blank-line-delimited paragraph on purpose, and that shape is
// load-bearing rather than cosmetic. Packed directly under `title: a` with no blank line,
// lines 2-4 lazily merge into a single paragraph that the trailing `---` closes as a SETEXT
// HEADING, so the image's Lezer parent stops being `Paragraph` and image-field.ts's parent
// gate (2) excludes it in BOTH states, independently of `fmEnd` — measured 0 -> 0, which
// pins nothing. The blank lines keep line 1's fence status the sole variable that moves the
// image across `fmEnd`. Measured 2026-09-02 on built, settled states: PRESENT is fmEnd=52
// with the image at 14 (enclosed, 0 widgets) and ABSENT is fmEnd=0 (exposed, 1 widget at
// 13-46), with `parent=Paragraph` on both sides.
const G3_OPENER_ABSENT = `--\ntitle: a\n\n${IMG}\n\n---\n\nbody`;
const G3_OPENER_PRESENT = `-${G3_OPENER_ABSENT}`;

// The CLOSER-EXISTENCE-flip pair — the third and last way `fmEnd` can change. The closer
// pair above moves an ALREADY-PRESENT closer to a different line; the opener pair flips
// line 1's own fence identity while a closer, if any, never moves. This pair instead makes
// the closer appear or disappear altogether while line 1 stays a fence in both states, so a
// check that only fires when both states already have a closer span (the closer pair's
// shape) or when line 1's fence status flips (the opener pair's shape) never sees this
// trigger — one side has no span at all. `G3_TRAILING_CLOSER` is `G3_NO_CLOSER` plus its own
// closer, so appending it IS the edit and deleting
// `[G3_NO_CLOSER.length, G3_TRAILING_CLOSER.length)` is its inverse. Measured 2026-09-02 on
// built, settled states: NO_CLOSER is fmEnd=0 (exposed, 1 widget) and TRAILING_CLOSER is
// fmEnd=58 (enclosed, 0 widgets).
const G3_NO_CLOSER = `---\ntitle: a\n\n${IMG}\n\nbody`;
const G3_TRAILING_CLOSER = `${G3_NO_CLOSER}\n\n---`;

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
    // The two rows below are the ones that pin the CLOSER-FENCE direction of image-field.ts's
    // G3 arm (the opener-flip pair and the closer-existence pair further down pin the other
    // two directions); the length-shift row above does not, and cannot. A length-only edit
    // INSIDE the fences moves leadingFrontmatterEnd by a couple of characters but never past
    // the image, so eligibility does not flip: with the arm hypothetically deleted,
    // computeExtendedSpan covers only the frontmatter's own lines, computeBounded re-emits
    // the untouched widget byte-identically, and the row stays green. What flips eligibility
    // is moving the CLOSER FENCE across the image, which is what these do — by deleting the
    // closer so the `---` below the image becomes the closer, and by inserting one back so
    // it stops being the closer. Both directions are pinned because the two failure shapes
    // are different: the enclosing direction leaves a STALE widget behind (prev is reused,
    // oracle has none) and the exposing direction leaves a MISSING one (the image sits
    // outside every bounded interval, so nothing builds it). Measured 2026-09-02: deleting
    // the G3 arm reds both.
    //
    // Neither row carries `cursorAtEnd`. The edit alone crosses the boundary, so appending a
    // second, selection-only dispatch is unneeded: it would re-enter update() with
    // leadingFrontmatterEnd already equal on both sides, adding a transaction that exercises
    // nothing these rows are pinning.
    {
      name: "G3 closer fence moves below the image — image becomes enclosed",
      initial: G3_IMAGE_EXPOSED,
      // Delete the closer line. The `---` below the image becomes the first fence after
      // line 1, so leadingFrontmatterEnd jumps past the image and demotes it.
      edits: [{ changes: { from: FM_OPEN.length, to: FM_OPEN.length + FENCE.length } }],
      oracleSlots: 0, // the image is inside the frontmatter now, so ZERO widgets is the answer
    },
    {
      name: "G3 closer fence moves above the image — image becomes exposed",
      initial: G3_IMAGE_ENCLOSED,
      // Insert a closer at line 3. leadingFrontmatterEnd retreats above the image, which
      // stops being frontmatter body and becomes a standalone image.
      edits: [{ changes: { from: FM_OPEN.length, insert: FENCE } }],
      oracleSlots: 1,
    },
    // The OPENER-flip direction of the same arm. The two closer rows above move the fence
    // that ENDS the frontmatter while line 1 stays a fence in both states; these two move
    // line 1 itself, so `detectLeadingFrontmatterInState` returns a span on one side and
    // `null` on the other. That distinction is what these rows exist for: narrowing the G3
    // check to a closer-only comparison — one that fires only when BOTH states have a span
    // and their `to` differs — leaves the closer rows green (both sides have a span there)
    // and reds only these, because on an opener flip the narrowed check never fires and the
    // bounded path runs instead. computeExtendedSpan covers line 1 and its neighbour, never
    // the image four lines below, so the two failure shapes mirror the closer pair: the
    // appearing direction leaves a STALE widget (prev is reused, oracle has none) and the
    // disappearing direction leaves a MISSING one (nothing rebuilds it). Measured
    // 2026-09-02: the narrowed arm reds both rows and the closer rows stay green.
    //
    // As with the closer pair, neither row carries `cursorAtEnd` — the edit alone crosses
    // the boundary, and a second selection-only dispatch would re-enter update() with
    // leadingFrontmatterEnd already equal on both sides.
    {
      name: "G3 opener appears on line 1 — image becomes enclosed",
      initial: G3_OPENER_ABSENT,
      // Complete line 1's fence. Frontmatter now spans down to the `---` BELOW the image,
      // so leadingFrontmatterEnd jumps from 0 past the image and demotes it.
      edits: [{ changes: { from: 0, insert: "-" } }],
      oracleSlots: 0, // the image is inside the frontmatter now, so ZERO widgets is the answer
    },
    {
      name: "G3 opener disappears from line 1 — image becomes exposed",
      initial: G3_OPENER_PRESENT,
      // Break line 1's fence. detect.ts's O(1) reject fires, leadingFrontmatterEnd drops to
      // 0, and the image stops being frontmatter body and becomes a standalone image.
      edits: [{ changes: { from: 0, to: 1 } }],
      oracleSlots: 1,
    },
    // The CLOSER-EXISTENCE-flip direction of the same arm. The closer pair moves an
    // ALREADY-PRESENT closer to a different line and the opener pair flips line 1's fence
    // identity; these two instead make the closer appear or disappear altogether while line
    // 1 stays a fence in both states, so a check narrowed to "both states already have a
    // closer span, and their `to` differs" (the closer pair's shape) or to an opener flip
    // (the opener pair's shape) never fires here — one side has no span at all — and the
    // bounded path runs instead. Measured 2026-09-02: that narrowed arm reds both rows below
    // while the closer and opener rows stay green.
    //
    // Neither row carries `cursorAtEnd` — the edit alone crosses the boundary, and a second
    // selection-only dispatch would re-enter update() with leadingFrontmatterEnd already
    // equal on both sides.
    {
      name: "G3 closer appears below the image — image becomes enclosed",
      initial: G3_NO_CLOSER,
      // Append a closer line. leadingFrontmatterEnd jumps from 0 past the image and demotes
      // it.
      edits: [{ changes: { from: G3_NO_CLOSER.length, insert: "\n\n---" } }],
      oracleSlots: 0, // the image is inside the frontmatter now, so ZERO widgets is the answer
    },
    {
      name: "G3 closer disappears from below the image — image becomes exposed",
      initial: G3_TRAILING_CLOSER,
      // Delete the closer line. detect.ts finds no closer at all, leadingFrontmatterEnd
      // drops to 0, and the image stops being frontmatter body and becomes a standalone
      // image.
      edits: [{ changes: { from: G3_NO_CLOSER.length, to: G3_TRAILING_CLOSER.length } }],
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

  it("door guard throws when no edit can produce a doc-visible transaction", () => {
    const inertEditLists: Edit[][] = [
      [],
      [{}],
      [{ changes: { from: 0 } }], // no `to`/`insert` — normalises to an empty ChangeSet
      [{ changes: { from: 0, to: 0 } }], // `to === from`, no `insert` — same normalisation
      [{ changes: { from: 0, to: 0, insert: "" } }], // `to === from` with an explicit empty insert
    ];
    // `prose\n\n${IMG}\n` settles to exactly 1 standalone image slot at rest (measured), so
    // a non-vacuous check on the guard's throw does not depend on it: with the guard
    // disabled these edits would dispatch as true no-ops and the comparison below would
    // pass, not throw, for an unrelated reason (an oracleSlots mismatch on a doc that
    // doesn't settle to that count at rest).
    for (const edits of inertEditLists) {
      expect(() => checkEquivalence(`prose\n\n${IMG}\n`, edits, 1)).toThrow();
    }
  });
});
