// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import type { DecorationSet, EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { blockStyle } from "../../../src/webview/cm/decorations/block-style.js";
import {
  CALLOUT_MARKER_HIDDEN_CLASS,
  calloutMarkerConceal,
} from "../../../src/webview/cm/decorations/callout.js";
import { calloutMarkerConcealField } from "../../../src/webview/cm/decorations/callout-marker-conceal.js";
import { quollSyntaxReveal } from "../../../src/webview/cm/decorations/index.js";
import { quollSyntaxExclusionZones } from "../../../src/webview/cm/decorations/orchestrator.js";
import { fullTree } from "../helpers/full-tree.js";
import { settledState } from "../helpers/settled-state.js";
import { settledMount } from "../helpers/settled-view.js";
import { withUnstarvedFrontier } from "../helpers/unstarved-frontier.js";

type SyntaxNode = ReturnType<typeof fullTree>["topNode"];

function stateFor(doc: string, caret: number): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(caret),
    extensions: [markdown({ base: markdownLanguage })],
  });
}

/** All Blockquote nodes in document (pre-order) order — [0] is the outermost. */
function blockquotes(state: EditorState): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  fullTree(state).iterate({
    enter: (n) => {
      if (n.name === "Blockquote") {
        out.push(n.node);
      }
    },
  });
  return out;
}

/** Flatten a DecorationSet to { from, to, cls } — a line deco is a point
 *  (from === to) carrying a class; a replace has from < to and an empty spec. */
function dump(set: DecorationSet): Array<{ from: number; to: number; cls?: string }> {
  const out: Array<{ from: number; to: number; cls?: string }> = [];
  const iter = set.iter();
  while (iter.value !== null) {
    const spec = iter.value.spec as { class?: string };
    out.push({ from: iter.from, to: iter.to, cls: spec.class });
    iter.next();
  }
  return out;
}

/** The field under test plus the language it walks. Kept as ONE definition because the
 *  oracle in `checkEquivalence` below is only a valid oracle while it is configured exactly
 *  like the live view it is compared against — two lists that drifted apart would quietly
 *  compare differently-configured fields. */
const concealExts = (): Extension[] => [
  markdown({ base: markdownLanguage }),
  calloutMarkerConcealField,
];

describe("calloutMarkerConceal — pure predicate", () => {
  it("caret OUTSIDE the block returns the marker line span", () => {
    const doc = "> [!NOTE]\n> body\n\npara";
    const state = stateFor(doc, doc.indexOf("para") + 1);
    const node = blockquotes(state)[0];
    const marker = state.doc.line(1);
    expect(calloutMarkerConceal(state.doc, state.selection, node)).toEqual({
      from: marker.from,
      to: marker.to,
    });
  });

  it("caret INSIDE the block returns null (revealed)", () => {
    const doc = "> [!NOTE]\n> body\n\npara";
    const state = stateFor(doc, 3); // caret in `[!NOTE]`
    const node = blockquotes(state)[0];
    expect(calloutMarkerConceal(state.doc, state.selection, node)).toBeNull();
  });

  it("a marker-only callout (no body) never conceals, even caret-outside", () => {
    const doc = "> [!NOTE]\n\npara";
    const state = stateFor(doc, doc.indexOf("para") + 1);
    const node = blockquotes(state)[0];
    expect(calloutMarkerConceal(state.doc, state.selection, node)).toBeNull();
  });

  it("a nested inner marker never conceals (only the outermost is a callout)", () => {
    const doc = "> [!WARNING]\n> > [!NOTE]\n\npara";
    const state = stateFor(doc, doc.indexOf("para") + 1);
    const inner = blockquotes(state)[1]; // the `> >` inner quote
    expect(calloutMarkerConceal(state.doc, state.selection, inner)).toBeNull();
  });

  it("an unknown `[!FOO]` is not a callout → null", () => {
    const doc = "> [!FOO]\n> body\n\npara";
    const state = stateFor(doc, doc.indexOf("para") + 1);
    const node = blockquotes(state)[0];
    expect(calloutMarkerConceal(state.doc, state.selection, node)).toBeNull();
  });

  it("a TAB-separated `>\\t[!NOTE]` marker conceals like the space form when caret-outside", () => {
    const doc = ">\t[!NOTE]\n> body\n\npara";
    const state = stateFor(doc, doc.indexOf("para") + 1);
    const node = blockquotes(state)[0];
    const marker = state.doc.line(1);
    expect(calloutMarkerConceal(state.doc, state.selection, node)).toEqual({
      from: marker.from,
      to: marker.to,
    });
  });
});

describe("calloutMarkerConcealField — StateField", () => {
  // Settled: calloutMarkerConcealField.create() reads syntaxTree(state), so on a
  // truncated init snapshot the field is built over a partial tree and the assertions
  // below observe an empty decoration set for a reason unrelated to the caret.
  function fieldState(doc: string, caret: number): EditorState {
    return settledState(
      EditorState.create({
        doc,
        selection: EditorSelection.single(caret),
        extensions: concealExts(),
      })
    );
  }

  it("caret OUTSIDE emits the replace + hidden line class and publishes the zone", () => {
    const doc = "> [!NOTE]\n> body\n\npara";
    const state = fieldState(doc, doc.indexOf("para") + 1);
    const marker = state.doc.line(1);
    const decos = dump(state.field(calloutMarkerConcealField).decorations);
    // A replace over the whole marker line [from, to).
    expect(decos).toContainEqual({ from: marker.from, to: marker.to, cls: undefined });
    // A zero-height line class at the line start.
    expect(
      decos.some(
        (d) =>
          d.from === marker.from && d.to === marker.from && d.cls === CALLOUT_MARKER_HIDDEN_CLASS
      )
    ).toBe(true);
    // The marker span is published to the exclusion facet.
    expect(state.facet(quollSyntaxExclusionZones)).toContainEqual({
      from: marker.from,
      to: marker.to,
    });
  });

  it("caret INSIDE emits nothing and publishes no zone", () => {
    const doc = "> [!NOTE]\n> body\n\npara";
    const state = fieldState(doc, 3); // caret in `[!NOTE]`
    expect(state.field(calloutMarkerConcealField).decorations.size).toBe(0);
    expect(state.facet(quollSyntaxExclusionZones)).toEqual([]);
  });

  it("a selection move outside→inside flips the conceal off (non-vacuous)", () => {
    const doc = "> [!NOTE]\n> body\n\npara";
    let state = fieldState(doc, doc.indexOf("para") + 1); // outside
    expect(state.field(calloutMarkerConcealField).decorations.size).toBeGreaterThan(0);
    state = state.update({ selection: { anchor: 3 } }).state; // into `[!NOTE]`
    expect(state.field(calloutMarkerConcealField).decorations.size).toBe(0);
    expect(state.facet(quollSyntaxExclusionZones)).toEqual([]);
  });

  it("an outside→outside move keeps the SAME exclusion-facet value identity (F3)", () => {
    const doc = "> [!NOTE]\n> body\n\npara";
    const state1 = fieldState(doc, doc.indexOf("para") + 1); // outside
    const state2 = state1.update({ selection: { anchor: doc.indexOf("para") + 2 } }).state; // still outside
    // The field returns `prev` verbatim (markers content-equal), so CM reuses the
    // combined facet value by reference — no churn that would make block-style
    // rebuild noisily on a plain caret move.
    expect(state2.facet(quollSyntaxExclusionZones)).toBe(state1.facet(quollSyntaxExclusionZones));
  });

  // Crash regression (v2 Finding 2): a marker line with inline markup
  // (`> [!TIP] **title**`) would, under an inline-provider design, leave two
  // overlapping Decoration.replace on the line (the `>` hide + the `**` hide) and
  // CodeMirror throws. The StateField owns the WHOLE line as ONE replace + publishes
  // its span, so quollSyntaxReveal's inline marks are arbitrated away — mounting the
  // full stack must NOT throw.
  it("mounts `> [!TIP] **title**` with the full reveal stack without throwing", () => {
    const doc = "> [!TIP] **title**\n> body\n\npara";
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    let view: EditorView | null = null;
    // settledMount, not a bare `new EditorView`: the decoration-range conflict this test
    // guards against is thrown while the view builds, so the not-toThrow still covers
    // construction — and settling additionally republishes the snapshot the assertion
    // below reads through (`v.state.field(...)` derives from `syntaxTree(state)`).
    expect(() => {
      view = settledMount({
        state: EditorState.create({
          doc,
          selection: EditorSelection.single(doc.indexOf("para") + 1), // caret outside
          extensions: [
            markdown({ base: markdownLanguage }),
            quollSyntaxReveal(),
            blockStyle,
            calloutMarkerConcealField,
          ],
        }),
        parent,
      });
    }).not.toThrow();
    // The field concealed the formatted-title marker row with a single replace.
    const v = view as unknown as EditorView;
    const marker = v.state.doc.line(1);
    const decos = dump(v.state.field(calloutMarkerConcealField).decorations);
    expect(decos).toContainEqual({ from: marker.from, to: marker.to, cls: undefined });
    v.destroy();
  });
});

describe("calloutMarkerConcealField — bounded recompute ≡ full recompute", () => {
  const CALLOUT = "> [!NOTE]\n> body";

  // Build a live field via EditorView, drive edits, then compare its selection-
  // independent `records` (plus the derived decorations/zones) to a freshly-created
  // state over the same doc+selection. Callout conceal has NO sticky path-dependent
  // state (records derive purely from tree+selection), so a fresh EditorState.create
  // IS a valid oracle.
  //
  // Where the settles go, and where they deliberately do NOT. The MOUNT settles because
  // calloutMarkerConcealField.create() reads syntaxTree(state): over a truncated init
  // snapshot the field's initial value is built on a partial tree and the first edit's
  // bounded path starts from a wrong `prev`. The ORACLE settles because that is what makes
  // `want` the true full recompute — and it closes a live vacuity, since comparing two
  // truncated-to-nothing sides passes for the wrong reason. The EDIT LOOP must NOT settle:
  // `forceParsing` dispatches whenever the completed tree differs from the published
  // snapshot, and that dispatch drives update()'s tree-identity branch into a full
  // buildFull — turning this bounded-vs-full compare into full-vs-full. The pin inside the
  // loop is what keeps the bounded result trustworthy instead.
  //
  // ⚠️ The comparison is ATTEMPTED rather than asserted on the first try, via
  // `withUnstarvedFrontier` — its docblock in ../helpers/unstarved-frontier.ts is where the
  // 20ms post-edit budget, why an attempt loop rather than a vitest-level `{ retry: n }`,
  // and why an all-starved run must throw rather than pass quietly are explained in full.
  // File-specific fact: this is the describe PR #388 measured redding under a deliberately
  // loaded full-suite run (24 spinners on 8 cores).
  function checkEquivalence(
    initial: string,
    edits: Array<{ changes?: unknown; selection?: unknown }>
  ): void {
    if (edits.length === 0) {
      // The gate inside the attempt is per-dispatch, so a zero-edit call exercises no
      // bounded path at all. This refuses it at the door, naming the actual mistake.
      // It is no longer the LAST line of defence — since this suite started running its
      // comparison through `withUnstarvedFrontier`, an empty edit loop never reaches the
      // gate, so the helper's own ungated refusal catches the case too (measured: deleting
      // this block reds with "observe() returned without calling
      // requireUnstarvedFrontier()", not with a settled-vs-settled pass). Keep it anyway:
      // that backstop reports a gating bug, which sends the reader to the helper rather
      // than to the missing edit that actually caused it.
      throw new Error(
        "checkEquivalence: at least one edit is required to exercise the bounded path"
      );
    }
    withUnstarvedFrontier({
      what: "the bounded path",
      mount: (parent) =>
        settledMount(
          {
            state: EditorState.create({
              doc: initial,
              selection: EditorSelection.single(0),
              extensions: concealExts(),
            }),
            parent,
          },
          10_000
        ),
      observe: (view, requireUnstarvedFrontier) => {
        for (const e of edits) {
          view.dispatch(e as never);
          // Anti-masking (Codex Conf 92): the frontier must be COMPLETE on THIS dispatch.
          // syntaxTreeAvailable reads the parse CONTEXT's `isDone` — the predicate the
          // field's docChanged arm ORs with `touchesStructuralReparse` to choose between
          // computeBoundedRecords and its G2 buildFull fallback. A true therefore rules out
          // the STARVED-frontier full walk; it does NOT rule out the structural-reparse one,
          // which the fence-above-callout case below deliberately takes. A false means the
          // frontier was starved and the field self-healed, which is not a defect: the
          // attempt is abandoned rather than comparing a full walk to a full walk. Nothing
          // may settle the view here either — a settle would republish the snapshot and
          // re-enter update() through the tree-identity branch, replacing the bounded
          // records with a full walk and vacating the compare below.
          requireUnstarvedFrontier();
        }
        const oracle = settledState(
          EditorState.create({
            doc: view.state.doc.toString(),
            selection: view.state.selection,
            extensions: concealExts(),
          })
        );
        const got = view.state.field(calloutMarkerConcealField);
        const want = oracle.field(calloutMarkerConcealField);
        // PRIMARY (Codex Conf 96): `records` is selection-INDEPENDENT, so comparing it
        // pins the bounded recompute REGARDLESS of caret position. The fixed caret at 0
        // sits inside a first-position callout and REVEALS its marker → empty decorations
        // there — so a divergent record for that callout would be invisible to a
        // decorations-only compare. The record compare closes that hole; decorations/zones
        // stay as the derived secondary check (both sides share the same caret).
        expect(got.records).toEqual(want.records);
        expect(dump(got.decorations)).toEqual(dump(want.decorations));
        expect(got.zones).toEqual(want.zones);
      },
    });
  }

  it("refuses a zero-edit call at the door, naming the missing edit", () => {
    // What the guard does, and therefore what this pins: a call with no edits is rejected
    // before the mount, with a message that names the missing edit rather than anything
    // about gating. Every other test here passes at least one edit, so without this one
    // the guard has no call site that reaches it.
    expect(() => checkEquivalence(CALLOUT, [])).toThrow(/at least one edit is required/);
  });

  it("type prose far below a callout (far edit, records position-shift only)", () => {
    checkEquivalence(`${CALLOUT}\n\nprose\n\nmore`, [
      { changes: { from: `${CALLOUT}\n\nprose\n\nmore`.length, insert: "x" } },
    ]);
  });

  it("edit the marker line: add/remove [!NOTE]-ness", () => {
    // Remove "[!NOTE]" → generic blockquote (record vanishes).
    checkEquivalence(`${CALLOUT}\n\nafter`, [{ changes: { from: 2, to: 9, insert: "hello" } }]);
  });

  it("introduce a callout from scratch", () => {
    checkEquivalence("plain\n\nmore", [{ changes: { from: 0, to: 5, insert: CALLOUT } }]);
  });

  it("insert a callout before an existing one", () => {
    checkEquivalence(`${CALLOUT}\n\ntail`, [{ changes: { from: 0, insert: `${CALLOUT}\n\n` } }]);
  });

  it("grow the callout body (append a body line)", () => {
    checkEquivalence(`${CALLOUT}\n\ntail`, [
      { changes: { from: CALLOUT.length, insert: "\n> more" } },
    ]);
  });

  // G1 merge: deleting the blank line between the callout and a following blockquote
  // MERGES them — the callout's block extent grows WITHOUT touching its marker bytes.
  it("G1 merge: delete blank line below the callout absorbs the next blockquote", () => {
    checkEquivalence(`${CALLOUT}\n\n> tail`, [
      { changes: { from: CALLOUT.length, to: CALLOUT.length + 1 } },
    ]);
  });

  // G1 split: inserting a blank line inside the block splits it — a marker-only head
  // (no body) stops concealing.
  it("G1 split: insert blank line after the marker demotes to marker-only", () => {
    // "> [!NOTE]\n> body" → "> [!NOTE]\n\n> body": the callout becomes body-less.
    checkEquivalence(CALLOUT, [{ changes: { from: 9, insert: "\n" } }]);
  });

  // G1 lazy-from-ABOVE (Codex review 2026-07-06): an edit on the first line of a
  // contiguous non-blank run flips whether a `[!TYPE]` line SEVERAL lines below
  // starts a new callout blockquote or merely continues the blockquote above it — a
  // ±1 window misses it. Deleting the leading `>` of line 1 promotes the later
  // `> [!NOTE]` block to a top-level callout. RED against the old ±1 bound.
  it("G1 lazy from above: deleting a leading > several lines up flips a later callout", () => {
    checkEquivalence("> body\nbody\n> [!NOTE]\n> more\n> more\nbody\nbody", [
      { changes: { from: 0, to: 1, insert: "" } },
    ]);
  });

  // G1 lazy-continuation (Codex Conf 90): deleting the blank line below the block
  // makes a following plain paragraph LAZILY continue the blockquote — the block
  // grows DOWNWARD across a line the edit does not touch. This is the case ±1 exists
  // for; the oracle pins that bounded reproduces it regardless of whether ±1 or
  // touchesRange is what caught it.
  it("G1 lazy: delete blank line below the callout lazily absorbs a plain paragraph", () => {
    checkEquivalence(`${CALLOUT}\n\nlazy tail`, [
      { changes: { from: CALLOUT.length, to: CALLOUT.length + 1 } },
    ]);
  });

  // Nested inner quote (Codex Conf 90): only the OUTERMOST callout is a record; an
  // inner `> >` never conceals. Editing the inner must not spawn a phantom record.
  it("nested inner callout-shaped quote is never a record", () => {
    checkEquivalence("> [!WARNING]\n> > [!NOTE]\n> > x", [
      { changes: { from: "> [!WARNING]\n> > ".length, insert: "y" } },
    ]);
  });

  // List-nested blockquote is NOT a callout (the marker regex rejects the `- ` prefix).
  // NOTE (Codex Conf 95): this is an empty≡empty REGRESSION GUARD, not a proof the
  // bounded walk fired — both sides emit no record, so it would stay green even under a
  // broken bound. It pins that list-nested stays non-callout (the scope decision above);
  // the addition/growth cases are what exercise the fresh walk.
  it("list-nested `- > [!NOTE]` yields no record either way (regression guard)", () => {
    checkEquivalence("- > [!NOTE]\n- item", [{ changes: { from: 0, insert: "x" } }]);
  });

  // Structural reparse from OUTSIDE the callout's block (the #67 guard): opening an
  // unclosed ``` fence in a paragraph ABOVE the callout turns the whole remainder of
  // the document into a code block, so the callout below is no longer a Blockquote —
  // its record must VANISH. The edit is confined to the intro paragraph, so the
  // changed-range bounded window never reaches the callout; without the
  // touchesStructuralReparse full-rebuild fallback the field would strand the stale
  // record (RED against the unguarded field, GREEN once the guard forces a full
  // rebuild — the fence insert matches the shared STRUCTURAL regex, so the guard fires).
  it("fence-above-callout: an unclosed fence in a paragraph above the callout drops the record", () => {
    checkEquivalence(`intro\n\n${CALLOUT}`, [{ changes: { from: 0, insert: "```\n" } }]);
  });

  it("multi-range (multi-cursor) transaction touching two callouts", () => {
    const doc = `${CALLOUT}\n\nmid\n\n> [!TIP]\n> t`;
    const tipMarker = doc.indexOf("[!TIP]");
    checkEquivalence(doc, [
      {
        changes: [
          { from: 2, to: 9, insert: "[!WARNING]" }, // first marker NOTE→WARNING
          { from: tipMarker, to: tipMarker + 6, insert: "[!CAUTION]" }, // second TIP→CAUTION
        ],
      },
    ]);
  });
});

describe("calloutMarkerConcealField — bounded reuse is non-vacuous (record identity)", () => {
  // RED against Task 1's full walk (fresh objects every docChanged), GREEN once Task 2
  // preserves a zero-shift reused record's object identity. Proves reuse is REAL, not
  // a value-equal coincidence (Codex Conf 95).
  // ⚠️ The observation is ATTEMPTED, not asserted on the first try: CodeMirror gives its
  // post-edit reparse a 20ms WALL-CLOCK budget, and under CPU starvation that window can
  // elapse while this process is descheduled. The field then legitimately self-heals with
  // a full walk (callout-marker-conceal.ts's `!syntaxTreeAvailable` arm), so reuse is not
  // what ran and there is nothing to observe — a fact about the machine, not about the
  // code under test. Why an attempt loop rather than a vitest `{ retry: n }`, and why an
  // all-starved run must fail rather than pass quietly, is explained in full on
  // `withUnstarvedFrontier` in ../helpers/unstarved-frontier.ts.
  it("an untouched far callout's record object survives a below-edit by identity", () => {
    const doc = "> [!NOTE]\n> body\n\nprose";
    withUnstarvedFrontier({
      what: "bounded reuse by record identity",
      // settledMount, not `new EditorView` + a bare ensureSyntaxTree: the field is built at
      // EditorState.create from syntaxTree(state), and an ensureSyntaxTree that only
      // advances the parse CONTEXT leaves that snapshot truncated. `records` is then EMPTY
      // and the identity assertion below compares `undefined` to `undefined` — green
      // without ever exercising reuse. The toBeDefined() pin makes that failure mode
      // impossible to reintroduce silently.
      mount: (parent) =>
        settledMount(
          {
            state: EditorState.create({
              doc,
              selection: EditorSelection.single(doc.length),
              extensions: concealExts(),
            }),
            parent,
          },
          10_000
        ),
      observe: (view, requireUnstarvedFrontier) => {
        const before = view.state.field(calloutMarkerConcealField).records[0];
        expect(before).toBeDefined();
        // Edit BELOW the callout (position doc.length): the record is untouched and does
        // not shift → the bounded path must return the SAME object.
        view.dispatch({ changes: { from: view.state.doc.length, insert: "x" } });
        requireUnstarvedFrontier(); // starved → the field took its G2 full walk; nothing to observe
        const after = view.state.field(calloutMarkerConcealField).records[0];
        expect(after).toBe(before); // reused by reference (RED on a full walk)
      },
    });
  });
});
