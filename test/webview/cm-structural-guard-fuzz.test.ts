// @vitest-environment happy-dom
//
// Chained differential fuzz over every field that imports `requiresFullBoundedRebuild`.
// Chains, not one-shot edits: the bug class is a STALE REUSED record, and a record can only
// go stale by surviving an edit. The evolving state is deliberately NEVER re-settled —
// `settledState` republishes the language snapshot and sends every field down its
// `!docChanged` tree-identity self-heal branch, full-rebuilding the very reuse under test.
//
// This is the CONSUMER-level check. It is NOT the soundness proof: reaching a geometry-
// specific bug by uniform random mutation has probability ≈ 0, which is why
// cm-structural-guard-exhaustive.test.ts enumerates instead of sampling.
import { syntaxTreeAvailable } from "@codemirror/language";
import { EditorState, type Extension, type RangeSet } from "@codemirror/state";
import type { Decoration, GutterMarker } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { calloutMarkerConcealField } from "../../src/webview/cm/decorations/callout-marker-conceal.js";
import {
  headingFoldGutterLineClass,
  headingRhythmFoldGutterLineClass,
  listFoldGutterLineClass,
  quollFolding,
} from "../../src/webview/cm/fold/index.js";
import { imageBlockField } from "../../src/webview/cm/image/image-field.js";
import { ImageBlockWidget } from "../../src/webview/cm/image/image-widget.js";
import { quollMarkdownLanguage } from "../../src/webview/cm/markdown.js";
import { requiresFullBoundedRebuild } from "../../src/webview/cm/structural-guard.js";
import { tableSkeletonField } from "../../src/webview/cm/table/table-skeleton.js";
import { settledState } from "./helpers/settled-state.js";
import { SHAPE_CORPUS } from "./helpers/table-shape-corpus.js";

const extensions = (): Extension[] => [
  quollMarkdownLanguage(),
  quollFolding(), // already contains the three fold gutter fields — do not mount them twice
  imageBlockField,
  tableSkeletonField,
  calloutMarkerConcealField,
];

/** Typed against the fields' REAL value type. `elementClass` is the only thing here that
 *  distinguishes one gutter marker from another — the three fold fields emit
 *  `quoll-fold-heading-1..3` at ranges that are identical whichever level is tagged — so a
 *  hand-rolled `unknown` + cast would let a marker refactor that drops the property degrade
 *  every entry to `from-to:undefined` on BOTH sides, silently reducing the differential to
 *  range-only. With the real type that refactor is a compile error. */
function serializeGutter(set: RangeSet<GutterMarker>) {
  const out: string[] = [];
  const c = set.iter();
  while (c.value) {
    out.push(`${c.from}-${c.to}:${c.value.elementClass}`);
    c.next();
  }
  return out.join("|");
}

/** Image widgets are compared by the widget's OWN identity fields, not merely by range —
 *  `ImageBlockWidget.eq` keys on (docFrom, slice), and a stale alt / safeUrl at an unchanged
 *  range is exactly the silent staleness this fuzz is for (Codex finding 3). */
function serializeImages(set: ReturnType<typeof Decoration.set>) {
  const out: string[] = [];
  const c = set.iter();
  while (c.value) {
    const w = (c.value.spec as { widget?: unknown }).widget;
    out.push(
      w instanceof ImageBlockWidget
        ? `${c.from}-${c.to}:${w.docFrom}:${w.alt}:${String(w.safeUrl)}:${w.slice}`
        : `${c.from}-${c.to}:?`
    );
    c.next();
  }
  return out.join("|");
}

function snapshot(state: EditorState): Record<string, string> {
  const callout = state.field(calloutMarkerConcealField);
  return {
    table: JSON.stringify(state.field(tableSkeletonField)),
    image: serializeImages(state.field(imageBlockField)),
    // The WHOLE callout value: `records` / `markers` / `zones` are what the selection-only
    // path reuses, so comparing `decorations` alone would miss a stale record.
    calloutRecords: JSON.stringify(callout.records),
    calloutMarkers: JSON.stringify(callout.markers),
    calloutZones: JSON.stringify(callout.zones),
    foldHeading: serializeGutter(state.field(headingFoldGutterLineClass)),
    foldList: serializeGutter(state.field(listFoldGutterLineClass)),
    foldRhythm: serializeGutter(state.field(headingRhythmFoldGutterLineClass)),
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = [
  "|",
  "-",
  ":",
  "=",
  "#",
  ">",
  "`",
  "_",
  "*",
  "+",
  ".",
  "!",
  "[",
  "]",
  "(",
  ")",
  "\\",
  " ",
  "\t",
  "x",
  "0",
  "\n",
];
const CHAINS = 160;
const EDITS_PER_CHAIN = 5;

describe("structural guard — differential fuzz over the real consumers", () => {
  it("keeps every bounded consumer equal to a fresh full build across 800 chained mutations", () => {
    const rng = mulberry32(0x5eed_1234);
    let compared = 0;
    let boundedPath = 0;
    let starved = 0;
    let inCellBounded = 0;
    const failures: string[] = [];

    for (let chain = 0; chain < CHAINS && failures.length === 0; chain++) {
      const doc = SHAPE_CORPUS[chain % SHAPE_CORPUS.length] as string;
      let state = settledState(EditorState.create({ doc, extensions: extensions() }));

      for (let edit = 0; edit < EDITS_PER_CHAIN && failures.length === 0; edit++) {
        const len = state.doc.length;
        const pos = Math.floor(rng() * (len + 1));
        const roll = rng();
        const ch = ALPHABET[Math.floor(rng() * ALPHABET.length)] as string;
        const changes =
          roll < 0.55
            ? { from: pos, to: pos, insert: ch }
            : roll < 0.85
              ? { from: pos, to: Math.min(len, pos + 1), insert: "" }
              : { from: pos, to: Math.min(len, pos + 1), insert: ch };
        if (changes.from === changes.to && changes.insert === "") {
          continue;
        }

        const tr = state.update({ changes });
        const next = tr.state;
        const bounded = !requiresFullBoundedRebuild(tr);
        // ⚠️ "the edited line holds a `|`" is NOT the class this narrowing recovers — a
        // pipe in prose or in a code fence satisfies it and would satisfy it under the OLD
        // arm too (Codex rev.2, Confidence 94). Ask the table field itself whether the edit
        // landed inside a real `Table` node.
        const inTable = state
          .field(tableSkeletonField)
          .some((m) => pos >= m.blockFrom && pos <= m.blockTo);
        // ⚠️ "inside a `Table` node" alone is NOT enough either: a table's trailing
        // overshoot line carries no pipe, and such an edit takes the bounded path under the
        // OLD presence arm too (measured: `inCellBounded` reached 23 with the arm reverted
        // to `oldSlice.includes("|") || newSlice.includes("|")`, clearing the old `> 20`
        // threshold). Require the EDITED LINE to carry a `|` as well — that is the exact
        // class the old arm fired on unconditionally, so it measures 0 under it.
        const oldLineText = state.doc.lineAt(Math.min(pos, state.doc.length)).text;
        const newLineText = next.doc.lineAt(Math.min(pos, next.doc.length)).text;
        if (bounded && inTable && (oldLineText.includes("|") || newLineText.includes("|"))) {
          inCellBounded++; // the class the narrowing recovers
        }

        if (!syntaxTreeAvailable(next, next.doc.length)) {
          starved++;
          state = next;
          continue;
        }
        compared++;
        if (bounded) {
          boundedPath++;
        }

        const oracle = settledState(
          EditorState.create({
            doc: next.doc.toString(),
            selection: next.selection,
            extensions: extensions(),
          })
        );
        const got = snapshot(next);
        const want = snapshot(oracle);
        for (const key of Object.keys(want)) {
          if (got[key] !== want[key]) {
            failures.push(
              `chain ${chain} edit ${edit} field ${key} bounded=${bounded}\n` +
                `doc: ${JSON.stringify(next.doc.toString())}\ngot:  ${got[key]}\nwant: ${want[key]}`
            );
          }
        }
        state = next;
      }
    }

    console.log(
      `fuzz census: compared=${compared} bounded=${boundedPath} inCellBounded=${inCellBounded} starved=${starved}`
    );
    expect(failures).toEqual([]);
    expect(compared).toBeGreaterThan(400);
    expect(boundedPath).toBeGreaterThan(50);
    // TARGETED non-vacuity: `bounded > 50` alone is satisfied by any pipe-free prose edit
    // and would hold for the OLD presence arm too, so it says nothing about this change.
    // An edit on a `|`-bearing line INSIDE a table taking the bounded path is possible ONLY
    // under the narrowed arm (Codex finding 4). Measured across six seeds
    // (0x5eed1234 / 1 / 2 / 3 / 999 / 424242, 2026-09-06): 72 / 94 / 86 / 104 / 97 / 72
    // under the shipped arm and 0 at EVERY seed with the arm reverted to the pre-PR
    // `oldSlice.includes("|") || newSlice.includes("|")` — under which this assertion reds.
    // The threshold sits below the lowest shipped reading so seed noise cannot red it, and
    // far above the 0 the old arm gives.
    expect(inCellBounded).toBeGreaterThan(50);
    expect(starved).toBeLessThan(compared / 4);
  }, 300_000);
});
