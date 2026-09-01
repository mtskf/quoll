// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AbsoluteOffset,
  asAbsoluteOffset,
  type CaretResolver,
  cellPointAt,
  defaultCaretResolver,
  quollTableCaretResolver,
} from "../../../src/webview/cm/table/cell-point.js";
import { renderCellInto } from "../../../src/webview/cm/table/cell-render.js";
import { asRenderedOffset } from "../../../src/webview/cm/table/cell-source-map.js";

// `fixture` mounts into the body and the containment gate is what several tests
// below assert on — leftovers from an earlier test would give a later one a
// second, identically-stamped cell to find. Cleanup is a mechanism, not a rule
// each test has to remember.
afterEach(() => {
  document.body.replaceChildren();
});

/** Build a minimal stamped widget-shaped DOM whose cells are filled the way the
 *  widget fills them — `renderCellInto`, which registers the source map
 *  `cellPointAt` reads. `md` is Markdown SOURCE, not rendered text: the mapping
 *  under test is exactly the one between those two, so a fixture that skipped
 *  the renderer would be testing a map no production code ever produces.
 *  `from`/`to` are the stamps, normally `md.length` apart (`Cell.raw` is the
 *  padding-free slice); a deliberate mismatch is what drives the stale-map rows. */
function fixture(cells: Array<{ md: string; from: number; to: number }>): HTMLElement {
  const root = document.createElement("div");
  root.className = "quoll-block quoll-table-block";
  root.dataset.docFrom = "0";
  const table = document.createElement("table");
  const tbody = document.createElement("tbody");
  const tr = document.createElement("tr");
  for (const c of cells) {
    const td = document.createElement("td");
    td.dataset.cellFrom = String(c.from);
    td.dataset.cellTo = String(c.to);
    renderCellInto(td, c.md);
    tr.appendChild(td);
  }
  tbody.appendChild(tr);
  table.appendChild(tbody);
  root.appendChild(table);
  document.body.appendChild(root);
  return root;
}

/** The same shape with the cell REPLACED by a hand-built one `renderCellInto`
 *  never touched, so `getCellSourceMap` genuinely answers null. Used by the rows
 *  that are about the trust boundary itself (malformed stamps, a cell nobody
 *  rendered), where going through the renderer would only add noise.
 *
 *  The clone is what makes that true: `fixture` renders every cell it builds, so
 *  a `replaceChildren` on the SAME element would swap the DOM while the WeakMap
 *  entry (keyed on the element) survived — the rows below would then exercise
 *  the staleness arms two later tests already cover, and the `map === null` arm
 *  would stay unpinned. `cloneNode(false)` copies the stamps, not the registry
 *  entry. */
function unmappedFixture(text: string, from: number, to: number): HTMLElement {
  const root = fixture([{ md: "", from, to }]);
  const td = root.querySelector("td") as HTMLElement;
  const fresh = td.cloneNode(false) as HTMLElement;
  fresh.appendChild(document.createTextNode(text));
  td.replaceWith(fresh);
  return root;
}

/** happy-dom has no layout, so the tests hand the mapping the DOM position a
 *  real caretPositionFromPoint would have returned. */
function resolverFor(node: Node | null, offset: number): CaretResolver {
  return () => (node === null ? null : { node, offset });
}

/** A cell whose 7 rendered characters are spread over three children — text,
 *  `<code>`, text — which is what makes the element-node (child-index) caret
 *  cases below distinguishable from the text-node ones. Source is 9 bytes (the
 *  backtick pair renders nothing), so it also exercises a mapping that a length
 *  comparison could never have made. */
const MIXED_MD = "ab`cde`fg";
function mixedChildrenCell(): { root: HTMLElement; td: HTMLElement } {
  const root = fixture([{ md: MIXED_MD, from: 5, to: 5 + MIXED_MD.length }]);
  return { root, td: root.querySelector("td") as HTMLElement };
}

describe("cellPointAt", () => {
  it("maps an offset inside a plain-text cell to an absolute source offset", () => {
    const root = fixture([{ md: "alpha", from: 78, to: 83 }]);
    const text = root.querySelector("td")?.firstChild as Node;
    expect(cellPointAt(root, 0, 0, resolverFor(text, 2))).toEqual({
      cellFrom: 78,
      cellTo: 83,
      offset: 80,
    });
  });

  // Inline markup used to be the disqualifier — `**bold**` is 8 source bytes
  // rendering as 4 characters, so the old length-equality gate answered `null`
  // for it and a drag selected the whole cell. The map places the boundary
  // exactly: rendered index 1 is source index 3, INSIDE the delimiters.
  it("maps an offset inside `**bold**` to the source character under it", () => {
    const root = fixture([{ md: "**bold**", from: 100, to: 108 }]);
    const text = root.querySelector("strong")?.firstChild as Node;
    expect(cellPointAt(root, 0, 0, resolverFor(text, 1))).toEqual({
      cellFrom: 100,
      cellTo: 108,
      offset: 103,
    });
  });

  // A boundary AT a run's edge expands over the markup the run's construct
  // owns, so selecting all of `bold` yields `**bold**` — the selection still
  // round-trips to the same rendered content instead of landing inside a
  // delimiter run and breaking it.
  it.each([
    [0, 100],
    [4, 108],
  ])("resolves the `**bold**` edge boundary %i to the construct edge", (within, expected) => {
    const root = fixture([{ md: "**bold**", from: 100, to: 108 }]);
    const text = root.querySelector("strong")?.firstChild as Node;
    expect(cellPointAt(root, 0, 0, resolverFor(text, within))?.offset).toBe(expected);
  });

  it("maps an offset inside a link LABEL past the `[` opener", () => {
    const md = "[label](https://example.com)";
    const root = fixture([{ md, from: 40, to: 40 + md.length }]);
    const text = root.querySelector("a")?.firstChild as Node;
    // Rendered "la|bel" → source `[la|bel](…)`: 40 + 1 (the `[`) + 2.
    expect(cellPointAt(root, 0, 0, resolverFor(text, 2))?.offset).toBe(43);
  });

  it("maps an offset inside `` `code` `` past the opening backtick", () => {
    const root = fixture([{ md: "`code`", from: 40, to: 46 }]);
    const text = root.querySelector("code")?.firstChild as Node;
    expect(cellPointAt(root, 0, 0, resolverFor(text, 2))?.offset).toBe(43);
  });

  // An escape renders ONE character from TWO source bytes. The boundary after
  // it must clear the whole sequence, or a selection ending there would split
  // `\|` and write a bare `|` into a table cell.
  it("resolves the boundary after an escaped `\\|` past both source bytes", () => {
    const root = fixture([{ md: "\\|", from: 40, to: 42 }]);
    const text = root.querySelector("td")?.firstChild as Node;
    expect(cellPointAt(root, 0, 0, resolverFor(text, 1))?.offset).toBe(42);
  });

  // A live image renders ZERO characters, so the rendered offsets on both sides
  // of it are the SAME number — nothing in a rendered offset can prove the
  // pointer crossed it. The map refuses rather than guess, and the caller snaps
  // outward exactly as it did for every marked-up cell before this change.
  it("reports offset null for a boundary beside a live in-cell image", () => {
    const md = "x![i](https://x.test/a.png)y";
    const root = fixture([{ md, from: 40, to: 40 + md.length }]);
    const y = root.querySelector("td")?.lastChild as Node;
    expect(cellPointAt(root, 0, 0, resolverFor(y, 0))).toEqual({
      cellFrom: 40,
      cellTo: 40 + md.length,
      offset: null,
    });
  });

  // NBSP is content, not padding: the parser's cell trimming is ASCII
  // space/tab only, so the stamps bracket it. The widget must render
  // `cell.raw` VERBATIM — a JS `.trim()` would strip the NBSP and shift every
  // rendered character one source byte left of where the stamps say it is.
  it("maps exactly inside an NBSP-padded cell (the anchoring contract)", () => {
    const root = fixture([{ md: "\u00a0x", from: 5, to: 7 }]);
    const text = root.querySelector("td")?.firstChild as Node;
    expect(cellPointAt(root, 0, 0, resolverFor(text, 1))?.offset).toBe(6);
  });

  it("reports offset null for a cell nobody rendered (no registered map)", () => {
    const root = unmappedFixture("alpha", 78, 83);
    const text = root.querySelector("td")?.firstChild as Node;
    expect(cellPointAt(root, 0, 0, resolverFor(text, 2))).toEqual({
      cellFrom: 78,
      cellTo: 83,
      offset: null,
    });
  });

  // `stampRow` re-points the stamps on a positional shift WITHOUT re-rendering,
  // so a map can outlive the span it describes. Length disagreement is the
  // cheap half of the staleness check.
  it("reports offset null when the map's sourceLength disagrees with the stamps", () => {
    const root = fixture([{ md: "alpha", from: 10, to: 18 }]);
    const text = root.querySelector("td")?.firstChild as Node;
    expect(cellPointAt(root, 0, 0, resolverFor(text, 2))).toEqual({
      cellFrom: 10,
      cellTo: 18,
      offset: null,
    });
  });

  // ...and the half a coincidence of lengths cannot fool. Here the stamps and
  // the map agree on LENGTH while the DOM has moved on, which is precisely the
  // state a length-only check waves through.
  it("reports offset null when the map's renderedText disagrees with the DOM", () => {
    const root = fixture([{ md: "alpha", from: 78, to: 83 }]);
    const td = root.querySelector("td") as HTMLElement;
    const text = td.firstChild as Node;
    td.appendChild(document.createTextNode("X"));
    expect(cellPointAt(root, 0, 0, resolverFor(text, 2))).toEqual({
      cellFrom: 78,
      cellTo: 83,
      offset: null,
    });
  });

  it("counts text across preceding sibling nodes inside the same cell", () => {
    const { root, td } = mixedChildrenCell();
    // Rendered "abcdef|g" is 6 characters in; source `ab\`cde\`f|g` is 8.
    expect(cellPointAt(root, 0, 0, resolverFor(td.lastChild as Node, 1))?.offset).toBe(13);
  });

  // Codex's counterexample for the hand-rolled walker this replaced: caret
  // (td, 2) means "before the third child", i.e. 5 chars in — the walker
  // returned 7 by running past the target subtree.
  it("resolves an element-node position between children (child index, not char index)", () => {
    const { root, td } = mixedChildrenCell();
    // Rendered index 5 is the junction between the code run's closers and the
    // trailing text run's start — both name source index 7, so it is exact.
    expect(cellPointAt(root, 0, 0, resolverFor(td, 2))?.offset).toBe(12); // 5 + 7
  });

  it("resolves an element-node position at child index 0 to the cell start", () => {
    const root = fixture([{ md: "alpha", from: 78, to: 83 }]);
    const td = root.querySelector("td") as HTMLElement;
    expect(cellPointAt(root, 0, 0, resolverFor(td, 0))?.offset).toBe(78);
  });

  it("resolves an element-node position past the last child to the cell end", () => {
    const root = fixture([{ md: "alpha", from: 78, to: 83 }]);
    const td = root.querySelector("td") as HTMLElement;
    expect(cellPointAt(root, 0, 0, resolverFor(td, 1))?.offset).toBe(83);
  });

  it("returns null when the resolver finds nothing", () => {
    const root = fixture([{ md: "alpha", from: 78, to: 83 }]);
    expect(cellPointAt(root, 0, 0, resolverFor(null, 0))).toBeNull();
  });

  it("fails closed when the resolver throws", () => {
    const root = fixture([{ md: "alpha", from: 78, to: 83 }]);
    const throwing: CaretResolver = () => {
      throw new Error("resolver exploded");
    };
    expect(() => cellPointAt(root, 0, 0, throwing)).not.toThrow();
    expect(cellPointAt(root, 0, 0, throwing)).toBeNull();
  });

  it("returns null when the point resolves outside this widget root", () => {
    const root = fixture([{ md: "alpha", from: 78, to: 83 }]);
    const outside = document.createElement("td");
    outside.dataset.cellFrom = "0";
    outside.dataset.cellTo = "3";
    outside.appendChild(document.createTextNode("xyz"));
    document.body.appendChild(outside);
    expect(cellPointAt(root, 0, 0, resolverFor(outside.firstChild as Node, 1))).toBeNull();
  });

  it("returns null when the point is in the widget but not in a cell (margin)", () => {
    const root = fixture([{ md: "alpha", from: 78, to: 83 }]);
    expect(cellPointAt(root, 0, 0, resolverFor(root, 0))).toBeNull();
  });

  it("returns null when a cell is missing its stamps", () => {
    const root = fixture([{ md: "alpha", from: 78, to: 83 }]);
    const td = root.querySelector("td") as HTMLElement;
    td.removeAttribute("data-cell-to");
    expect(cellPointAt(root, 0, 0, resolverFor(td.firstChild as Node, 2))).toBeNull();
  });

  // Trust-boundary hardening: the stamps are DOM attributes, so anything that
  // can touch the widget's DOM can write them, and the value flows straight
  // into `view.dispatch({selection})`. CodeMirror does NOT backstop this — its
  // `checkSelection` only rejects `range.to > doc.length`, so a negative, a
  // fraction and `NaN` all pass and install a silently broken selection.
  //
  // Coverage note: only the first three rows below distinguish the current gate
  // from a plain `Number.isFinite` one (`Number("")` is 0, and finite happily
  // admits -5 and 78.5). "abc" → NaN was rejected by the older gate too — it is
  // a control, not a new pin.
  it.each([
    ["empty", ""],
    ["negative", "-5"],
    ["fractional", "78.5"],
    ["non-numeric", "abc"],
  ])("returns null for a %s data-cell-from stamp", (_label, raw) => {
    const root = fixture([{ md: "alpha", from: 78, to: 83 }]);
    const td = root.querySelector("td") as HTMLElement;
    td.setAttribute("data-cell-from", raw);
    expect(cellPointAt(root, 0, 0, resolverFor(td.firstChild as Node, 2))).toBeNull();
  });

  // The `Number.isSafeInteger` arm — the only rejection the digit regexp cannot
  // make on its own, and dead until a stamp is long enough to lose precision
  // (`Number("9007199254740993")` is 9007199254740992). BOTH stamps carry a
  // huge value on purpose: stamping only `from` would let the
  // `cellTo < cellFrom` guard answer null first, and the row would pin nothing.
  // With the arm removed the pair survives as a plausible span, the map's
  // staleness check answers `{…, offset: null}` — an object, not null.
  it("returns null for a precision-losing stamp (isSafeInteger, past the digit regexp)", () => {
    const root = fixture([{ md: "alpha", from: 78, to: 83 }]);
    const td = root.querySelector("td") as HTMLElement;
    td.setAttribute("data-cell-from", "9007199254740993");
    td.setAttribute("data-cell-to", "9007199254740994");
    expect(cellPointAt(root, 0, 0, resolverFor(td.firstChild as Node, 2))).toBeNull();
  });

  it("returns null when the stamps are inverted (cellTo < cellFrom)", () => {
    const root = fixture([{ md: "alpha", from: 83, to: 78 }]);
    const td = root.querySelector("td") as HTMLElement;
    expect(cellPointAt(root, 0, 0, resolverFor(td.firstChild as Node, 2))).toBeNull();
  });

  // The other side of that boundary, and the reason it is `cellTo < cellFrom`
  // rather than `<=`: an empty GFM cell (`| a || b |`) stamps cellFrom ===
  // cellTo, and it is a perfectly good click target — tightening the guard to
  // `<=` would silently kill click-to-reveal on every empty cell.
  it("maps a point in an EMPTY cell (cellFrom === cellTo is a valid span)", () => {
    const root = fixture([{ md: "", from: 5, to: 5 }]);
    const td = root.querySelector("td") as HTMLElement;
    expect(cellPointAt(root, 0, 0, resolverFor(td, 0))).toEqual({
      cellFrom: 5,
      cellTo: 5,
      offset: 5,
    });
  });

  // `CaretResolver`'s throw contract deliberately admits a malformed answer, and
  // TypeScript cannot police the return value of a function reached through a
  // facet. Dereferencing it must not take down the widget's click listener —
  // same contract as the throwing resolver above.
  it.each([
    ["a null node", { node: null, offset: 0 }],
    ["a missing node", { offset: 0 }],
    ["undefined", undefined],
  ])("fails closed when the resolver returns %s", (_label, value) => {
    const root = fixture([{ md: "alpha", from: 78, to: 83 }]);
    const malformed = (() => value) as unknown as CaretResolver;
    expect(() => cellPointAt(root, 0, 0, malformed)).not.toThrow();
    expect(cellPointAt(root, 0, 0, malformed)).toBeNull();
  });

  // `Range.setEnd` throws IndexSizeError past the node's length (real DOM and
  // happy-dom alike — RangeUtility.validateBoundaryPoint), so an out-of-range
  // resolver offset fails CLOSED to "no exact mapping" rather than being
  // silently clamped to a position the pointer was never at.
  it("reports offset null for an out-of-range resolver offset", () => {
    const root = fixture([{ md: "alpha", from: 78, to: 83 }]);
    const text = root.querySelector("td")?.firstChild as Node;
    expect(cellPointAt(root, 0, 0, resolverFor(text, 99))).toEqual({
      cellFrom: 78,
      cellTo: 83,
      offset: null,
    });
  });

  it("passes the widget's OWN document to the resolver", () => {
    const root = fixture([{ md: "alpha", from: 78, to: 83 }]);
    let seen: Document | null = null;
    cellPointAt(root, 1, 2, (_x, _y, doc) => {
      seen = doc;
      return null;
    });
    expect(seen).toBe(root.ownerDocument);
  });
});

// The resolver production actually runs (nothing in src/ provides the facet, so
// the combine's empty arm is the live path). happy-dom exposes neither caret
// API, so every branch is driven through a hand-built fake `Document` — no
// layout engine needed. Without this block the module's only production path is
// 100% unexecuted: the argument order, the two result mappings, the `.bind`
// receiver, and the Chromium-124-first branch preference would all be free to
// break with a green suite.
describe("defaultCaretResolver", () => {
  const node = document.createTextNode("alpha");

  it("maps caretPositionFromPoint (offsetNode/offset) and forwards x,y in that order", () => {
    const seen: Array<[number, number]> = [];
    const doc = {
      caretPositionFromPoint(this: unknown, x: number, y: number) {
        seen.push([x, y]);
        // `this` must be the document — a missing `.bind(doc)` is an illegal
        // invocation in Chromium, which no other assertion here would catch.
        if (this !== doc) {
          throw new TypeError("illegal invocation");
        }
        return { offsetNode: node, offset: 3 };
      },
    } as unknown as Document;
    expect(defaultCaretResolver(11, 22, doc)).toEqual({ node, offset: 3 });
    expect(seen).toEqual([[11, 22]]);
  });

  it("returns null when caretPositionFromPoint yields null", () => {
    const doc = { caretPositionFromPoint: () => null } as unknown as Document;
    expect(defaultCaretResolver(0, 0, doc)).toBeNull();
  });

  // The Chromium 124 path — `engines.vscode ^1.94`, where the standards-track
  // API does not exist. This is the LIVE mapping on the oldest supported host.
  it("falls back to caretRangeFromPoint (startContainer/startOffset)", () => {
    const seen: Array<[number, number]> = [];
    const doc = {
      caretRangeFromPoint(this: unknown, x: number, y: number) {
        seen.push([x, y]);
        if (this !== doc) {
          throw new TypeError("illegal invocation");
        }
        return { startContainer: node, startOffset: 4 };
      },
    } as unknown as Document;
    expect(defaultCaretResolver(11, 22, doc)).toEqual({ node, offset: 4 });
    expect(seen).toEqual([[11, 22]]);
  });

  it("returns null when caretRangeFromPoint yields null", () => {
    const doc = { caretRangeFromPoint: () => null } as unknown as Document;
    expect(defaultCaretResolver(0, 0, doc)).toBeNull();
  });

  it("prefers the standards-track caretPositionFromPoint when BOTH exist", () => {
    const other = document.createTextNode("beta");
    const doc = {
      caretPositionFromPoint: () => ({ offsetNode: node, offset: 1 }),
      caretRangeFromPoint: () => ({ startContainer: other, startOffset: 9 }),
    } as unknown as Document;
    expect(defaultCaretResolver(0, 0, doc)).toEqual({ node, offset: 1 });
  });

  it("returns null where the platform has neither API (happy-dom)", () => {
    expect(defaultCaretResolver(0, 0, {} as unknown as Document)).toBeNull();
  });
});

describe("quollTableCaretResolver", () => {
  it("defaults to a resolver that yields null where the platform has no caret API", () => {
    const state = EditorState.create({});
    // happy-dom exposes neither caret API, so the production default degrades to
    // "no drag mapping" — which is what keeps every pre-existing plain-click
    // test on its original collapsed-caret path.
    expect(state.facet(quollTableCaretResolver)(0, 0, document)).toBeNull();
  });

  it("uses the last provided resolver", () => {
    const stub: CaretResolver = () => ({ node: document.body, offset: 7 });
    const state = EditorState.create({ extensions: [quollTableCaretResolver.of(stub)] });
    expect(state.facet(quollTableCaretResolver)(0, 0, document)?.offset).toBe(7);
  });
});

// The absolute space is branded where it is declared (this module). Pinned here
// for the same reason as the two rows in cm-table-cell-source-map.test.ts: tsc
// type-checks this directory, so an unneeded directive is TS2578.
describe("absolute offset brand", () => {
  it("refuses the cross-space sum the source map's header warns about", () => {
    const cellFrom = asAbsoluteOffset(40);
    const within = asRenderedOffset(2);
    // TS types `branded + branded` as plain `number`, so the ADD itself is not
    // an error — the brand bites here, at the consumption: the sum cannot pass
    // as an absolute document offset without an explicit, reviewable mint.
    // @ts-expect-error — `number` is not an AbsoluteOffset.
    const wrong: AbsoluteOffset = cellFrom + within;
    expect(wrong).toBe(42);
  });
});
