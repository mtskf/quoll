// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  EditorSelection,
  EditorState,
  type Extension,
  type SelectionRange,
} from "@codemirror/state";
import type { DecorationSet, WidgetType } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { leadingFrontmatterEnd } from "../../src/webview/cm/frontmatter/detect.js";
import { imageBlockField } from "../../src/webview/cm/image/index.js";
import { touchesStructuralReparse } from "../../src/webview/cm/structural-guard.js";
import { settledState } from "./helpers/settled-state.js";
import { settledMount } from "./helpers/settled-view.js";
import { withUnstarvedFrontier } from "./helpers/unstarved-frontier.js";

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
// ⚠️ The comparison is ATTEMPTED rather than asserted on the first try, which is why this
// runs through `withUnstarvedFrontier` (helpers/unstarved-frontier.ts) rather than a local
// loop. CodeMirror gives its post-edit reparse a 20ms WALL-CLOCK budget, and under CPU
// starvation that window can elapse while this process is descheduled; image-field.ts's G2
// arm then self-heals with a full recompute, so the bounded path is not what ran and there
// is nothing to compare. Retrying from a fresh view neither hides a regression (a real
// bounded bug reds every attempt that gets far enough to compare — measured by breaking
// computeBounded) nor passes vacuously (an all-starved run throws, and that throw is pinned
// in helpers/unstarved-frontier.test.ts rather than living unguarded here, which is the
// whole reason the loop moved), which a vitest-level `{ retry: n }` would fail on both
// counts.
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
  withUnstarvedFrontier({
    what: "the bounded-vs-full slot comparison",
    mount: (parent) =>
      settledMount(
        { state: EditorState.create({ doc: initial, extensions: exts() }), parent },
        10_000
      ),
    observe: (view, requireUnstarvedFrontier) => {
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
        // gate call right below is itself inside that window — that advances the parse or
        // publishes a tree: no settle, no parse-advancing read (ensureSyntaxTree, a
        // `fullTree` probe, forceParsing, …), no second doc-changing dispatch, and no
        // `await` or timer flush that yields to the event loop. The gate's no-op guarantee
        // depends on this loop staying straight-line synchronous code end to end; break
        // that shape and the guarantee breaks with it.
        //
        // ⚠️ What passing the gate rules out is the STARVED-frontier full walk, and nothing
        // more. imageBlockField.update takes its G3 arm — computeFreshFull — whenever
        // leadingFrontmatterEnd changes, BEFORE this predicate is ever consulted
        // (image-field.ts), so passing does not mean the bounded path ran. The seven "G3"
        // rows below take that arm, and what they compare there is the field's
        // INCREMENTALLY parsed full walk against the oracle's freshly parsed one — not
        // bounded against full. That is not a hole: it is how those rows pin the arm, since
        // with the arm deleted the bounded path runs INSTEAD and gets the answer wrong. But
        // only the six BOUNDARY-CROSSING rows do that pinning; the "frontmatter length
        // shift" row stays green either way (measured 2026-09-02, both claims). A starved
        // frontier does not return from the gate: the attempt is abandoned rather than
        // comparing a full walk over a PARTIAL tree against the settled oracle.
        requireUnstarvedFrontier();
      }
      // The oracle is a SEPARATE state, so settling it moves nothing on the view and the
      // gate above still speaks for what is compared below — which is also what keeps the
      // helper's post-gate state-identity check satisfied.
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
    },
  });
}

const IMG = "![alt](https://example.com/a.png)";

// Three G3 fixture pairs follow. Each crosses `leadingFrontmatterEnd` by a different
// mechanism — the closer fence MOVES to another line, line 1's own fence identity FLIPS, or
// the closer APPEARS/DISAPPEARS while line 1 stays a fence — and each pair is one document
// plus the edit that produces the other, which is what lets a single pair cover both
// directions of its crossing.

// The CLOSER-FENCE pair, whose edits are written as offsets off these constants rather than
// as literal numbers so renaming the body key cannot silently point the edit at the wrong
// line. `FM_OPEN` is exactly the opener line plus the one body line, so `FM_OPEN.length` IS
// line 2's `to`; `FENCE` is the closer line with its preceding newline, so inserting it
// there ADDS a closer at line 3 and deleting
// `[FM_OPEN.length, FM_OPEN.length + FENCE.length)` REMOVES it again.
const FM_OPEN = "---\ntitle: a";
const FENCE = "\n---";
// EXPOSED closes the fence at line 3, so the image below it sits outside the frontmatter
// and renders as a widget. ENCLOSED has no closer until the `---` BELOW the image, so
// leadingFrontmatterEnd swallows the image and it stays raw source.
const G3_IMAGE_EXPOSED = `${FM_OPEN}${FENCE}\n\nintro\n\n${IMG}\n\n---\n\nbody`;
const G3_IMAGE_ENCLOSED = `${FM_OPEN}\n\nintro\n\n${IMG}\n\n---\n\nbody`;

// The OPENER pair. `detect.ts` starts with an O(1) reject — line 1 must itself be a fence —
// so these two docs differ by exactly one dash at offset 0, written as a prefix off the
// other so the "one dash on line 1, nothing else" invariant is textual rather than a promise
// in a comment: prepending it IS the edit, and deleting `[0, 1)` is its inverse.
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

// The CLOSER-EXISTENCE pair. Line 1 stays a fence in both states and the closer appears or
// disappears altogether, so one side has no closer span at all. `G3_TRAILING_CLOSER` is
// `G3_NO_CLOSER` plus `TRAILING_CLOSER`, so inserting that constant at `G3_NO_CLOSER.length`
// IS the edit and deleting `[G3_NO_CLOSER.length, G3_TRAILING_CLOSER.length)` is its
// inverse. Measured 2026-09-02 on built, settled states: NO_CLOSER is fmEnd=0 (exposed, 1
// widget) and TRAILING_CLOSER is fmEnd=58 (enclosed, 0 widgets).
const G3_NO_CLOSER = `---\ntitle: a\n\n${IMG}\n\nbody`;
const TRAILING_CLOSER = "\n\n---";
const G3_TRAILING_CLOSER = `${G3_NO_CLOSER}${TRAILING_CLOSER}`;

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
    // The six rows below — three pairs, one per fixture pair above — are the ones that pin
    // image-field.ts's G3 arm; the length-shift row above does not, and cannot. A length-only
    // edit INSIDE the fences moves leadingFrontmatterEnd by a couple of characters but never
    // past the image, so eligibility does not flip: with the arm hypothetically deleted,
    // computeExtendedSpan covers only the frontmatter's own lines, computeBounded re-emits
    // the untouched widget byte-identically, and the row stays green. Each of the six instead
    // moves the image ACROSS leadingFrontmatterEnd, and every pair covers both directions
    // because the two failure shapes are different: the enclosing direction leaves a STALE
    // widget behind (prev is reused, oracle has none) and the exposing direction leaves a
    // MISSING one (the image sits outside every bounded interval, so nothing builds it).
    //
    // None of the six carries `cursorAtEnd`. The edit alone crosses the boundary, so
    // appending a second, selection-only dispatch is unneeded: it would re-enter update()
    // with leadingFrontmatterEnd already equal on both sides, adding a transaction that
    // exercises nothing these rows are pinning.
    //
    // The CLOSER-FENCE pair: delete the closer so the `---` below the image becomes the
    // closer, and insert one back so it stops being the closer. Measured 2026-09-02: deleting
    // the G3 arm reds both.
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
    // The OPENER-FLIP pair: line 1 itself moves, so `detectLeadingFrontmatterInState` returns
    // a span on one side and `null` on the other, and computeExtendedSpan covers line 1 and
    // its neighbour but never the image four lines below. Measured 2026-09-02: narrowing the
    // G3 check to a closer-only comparison — one that fires only when BOTH states have a span
    // and their `to` differs — reds both rows below while the closer-fence rows stay green
    // (both sides have a span there), because on an opener flip the narrowed check never
    // fires and the bounded path runs instead.
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
    // The CLOSER-EXISTENCE pair: the closer appears or disappears altogether while line 1
    // stays a fence, so one side has no closer span at all. Measured 2026-09-02: narrowing
    // the G3 check to either of the two shapes above — "both states have a span and their
    // `to` differs", or "line 1's fence status flipped" — reds both rows below while the
    // closer-fence and opener rows stay green, because neither narrowed check fires here and
    // the bounded path runs instead.
    {
      name: "G3 closer appears below the image — image becomes enclosed",
      initial: G3_NO_CLOSER,
      // Append a closer line. leadingFrontmatterEnd jumps from 0 past the image and demotes
      // it.
      edits: [{ changes: { from: G3_NO_CLOSER.length, insert: TRAILING_CLOSER } }],
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
    {
      // A structural reparse: an unclosed ``` typed on line 1 swallows the image below
      // into a FencedCode node, so the Image node vanishes with NO edit inside its own
      // bytes and with a COMPLETE frontier — the crossing neither the bounded reuse rule
      // nor G2 can see. Measured on the unguarded field: a stale widget survived at 10-43
      // against an oracle holding none.
      name: "structural reparse — an unclosed fence above swallows the image",
      initial: `intro\n\n${IMG}\n\ntail\n`,
      edits: [{ changes: { from: 0, insert: "```" } }],
      oracleSlots: 0,
    },
    {
      // Same crossing, a DIFFERENT Lezer mechanism: an HTML block absorbs the image
      // instead of a fence swallowing it.
      name: "structural reparse — an HTML comment above swallows the image",
      initial: `intro\n\n${IMG}\n\ntail\n`,
      edits: [{ changes: { from: 0, to: 5, insert: "<!--" } }],
      oracleSlots: 0,
    },
    {
      // The REVEAL direction: the image starts INSIDE an unclosed fence, and breaking that
      // fence exposes it. The unguarded field misses the new widget entirely rather than
      // stranding an old one — a different failure, same root cause.
      name: "structural reparse — breaking an unclosed fence reveals the image",
      initial: `\`\`\`\n\n${IMG}\n\ntail\n`,
      edits: [{ changes: { from: 0, to: 1, insert: "" } }],
      oracleSlots: 1,
    },
  ];
  for (const c of cases) {
    it(c.name, () => checkEquivalence(c.initial, c.edits, c.oracleSlots));
  }

  // The guard's breadth (structural-guard.ts) routes many of the rows above to the FULL arm
  // — a newline delta or a blank-line flip is enough. That is sound, and those rows keep
  // their value as full-vs-oracle checks, but it thins out the ones that still reach
  // `computeBounded` through the docChanged arm. Pin the two below so a widened guard or a
  // re-fixtured row cannot quietly leave this file blind to a bounded regression.
  //
  // NOT a claim that these are the only rows on the bounded path: the selection-driven rows
  // further down reach `computeBounded` through the SELECTION arm, which this guard does not
  // touch. This pins two; it does not census the file.
  //
  // The G3 rows are deliberately NOT here: their edit moves `leadingFrontmatterEnd`, so the
  // field returns from the frontmatter arm ABOVE this condition and never consults it. A
  // `toBe(false)` on one of them would be green and would mean nothing.
  it("these docChanged cases still reach the bounded arm", () => {
    const boundedRows = [
      { doc: "plain text\n", change: { from: 0, to: 10, insert: IMG } },
      { doc: `${IMG}\n\nbelow`, change: { from: 20, insert: "z" } },
    ];
    for (const r of boundedRows) {
      const state = settledState(EditorState.create({ doc: r.doc, extensions: exts() }));
      const tr = state.update({ changes: r.change });
      // Both halves matter: the frontmatter arm must not fire (or the row never reaches the
      // structural condition), and the structural condition must be false (or it full-walks).
      expect(leadingFrontmatterEnd(tr.startState)).toBe(leadingFrontmatterEnd(tr.state));
      expect(touchesStructuralReparse(tr)).toBe(false);
    }
  });

  it("door guard throws when no edit can produce a doc-visible transaction", () => {
    const inertEditLists: Edit[][] = [
      [],
      [{}],
      [{ changes: { from: 0 } }], // no `to`/`insert` — normalises to an empty ChangeSet
      [{ changes: { from: 0, to: 0 } }], // `to === from`, no `insert` — same normalisation
      [{ changes: { from: 0, to: 0, insert: "" } }], // `to === from` with an explicit empty insert
    ];
    // `prose\n\n${IMG}\n` settles to exactly 1 standalone image slot at rest (measured), so
    // this is a non-vacuous check on the guard: with the guard disabled, the four non-empty
    // lists dispatch as true no-ops, reach the gate inside checkEquivalence's `for` loop, and
    // the comparison below passes rather than throwing. `[]` does not follow that path — its
    // `for` loop body never runs, so the gate is never reached and `requireUnstarvedFrontier`
    // is never called — MEASURED for each row (`false && ...` in place of the `if` above turns
    // every row in this loop red, `[]` included: the four non-empty rows stop throwing at
    // all, and `[]` still throws, but as the HELPER's ungated-refusal message instead of this
    // one, so the exact-message match below catches that row too).
    // `[]` is kept as its own row rather than folded into the non-empty ones because it
    // takes a different route through the guard: `Array.prototype.every` on `[]` is
    // vacuously true without ever calling the predicate, so `[]` is what pins that the guard
    // treats "no edits at all" as inert by that vacuous truth, not by having evaluated
    // anything. Today the guard catches it first either way — measured: with the guard
    // present, `[]` throws THIS function's own message, same as the four non-empty rows,
    // never reaching `withUnstarvedFrontier` at all (`edits.every(...)` short-circuits the
    // `if` above before the helper is ever called).
    for (const edits of inertEditLists) {
      expect(() => checkEquivalence(`prose\n\n${IMG}\n`, edits, 1)).toThrow(
        /^checkEquivalence: at least one edit with `changes`, `selection`, or `cursorAtEnd` is required/
      );
    }
  });
});
