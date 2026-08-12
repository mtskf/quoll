// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import {
  type CaretResolver,
  cellPointAt,
  quollTableCaretResolver,
} from "../../../src/webview/cm/table/cell-point.js";

/** Build a minimal stamped widget-shaped DOM. */
function fixture(cells: Array<{ text: string; from: number; to: number }>): HTMLElement {
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
    td.appendChild(document.createTextNode(c.text));
    tr.appendChild(td);
  }
  tbody.appendChild(tr);
  table.appendChild(tbody);
  root.appendChild(table);
  document.body.appendChild(root);
  return root;
}

/** happy-dom has no layout, so the tests hand the mapping the DOM position a
 *  real caretPositionFromPoint would have returned. */
function resolverFor(node: Node | null, offset: number): CaretResolver {
  return () => (node === null ? null : { node, offset });
}

describe("cellPointAt", () => {
  it("maps an offset inside a byte-aligned cell to an absolute source offset", () => {
    const root = fixture([{ text: "alpha", from: 78, to: 83 }]);
    const text = root.querySelector("td")?.firstChild as Node;
    expect(cellPointAt(root, 0, 0, resolverFor(text, 2))).toEqual({
      cellFrom: 78,
      cellTo: 83,
      offset: 80,
    });
  });

  it("reports offset null when the rendered text is not byte-aligned with source", () => {
    // `**bold**` is 8 source bytes rendering as 4 characters.
    const root = fixture([{ text: "bold", from: 10, to: 18 }]);
    const text = root.querySelector("td")?.firstChild as Node;
    expect(cellPointAt(root, 0, 0, resolverFor(text, 2))).toEqual({
      cellFrom: 10,
      cellTo: 18,
      offset: null,
    });
  });

  it("counts text across preceding sibling nodes inside the same cell", () => {
    const root = fixture([{ text: "", from: 5, to: 12 }]);
    const td = root.querySelector("td") as HTMLElement;
    td.textContent = "";
    td.appendChild(document.createTextNode("ab"));
    const code = document.createElement("code");
    code.textContent = "cde";
    td.appendChild(code);
    td.appendChild(document.createTextNode("fg"));
    // "ab" + "cde" + "fg" = 7 chars === cellTo - cellFrom → byte-aligned.
    expect(cellPointAt(root, 0, 0, resolverFor(td.lastChild as Node, 1))?.offset).toBe(11);
  });

  // Codex's counterexample for the hand-rolled walker this replaced: caret
  // (td, 2) means "before the third child", i.e. 5 chars in — the walker
  // returned 7 by running past the target subtree.
  it("resolves an element-node position between children (child index, not char index)", () => {
    const root = fixture([{ text: "", from: 5, to: 12 }]);
    const td = root.querySelector("td") as HTMLElement;
    td.textContent = "";
    td.appendChild(document.createTextNode("ab"));
    const code = document.createElement("code");
    code.textContent = "cde";
    td.appendChild(code);
    td.appendChild(document.createTextNode("fg"));
    expect(cellPointAt(root, 0, 0, resolverFor(td, 2))?.offset).toBe(10); // 5 + 5
  });

  it("resolves an element-node position at child index 0 to the cell start", () => {
    const root = fixture([{ text: "alpha", from: 78, to: 83 }]);
    const td = root.querySelector("td") as HTMLElement;
    expect(cellPointAt(root, 0, 0, resolverFor(td, 0))?.offset).toBe(78);
  });

  it("resolves an element-node position past the last child to the cell end", () => {
    const root = fixture([{ text: "alpha", from: 78, to: 83 }]);
    const td = root.querySelector("td") as HTMLElement;
    expect(cellPointAt(root, 0, 0, resolverFor(td, 1))?.offset).toBe(83);
  });

  it("returns null when the resolver finds nothing", () => {
    const root = fixture([{ text: "alpha", from: 78, to: 83 }]);
    expect(cellPointAt(root, 0, 0, resolverFor(null, 0))).toBeNull();
  });

  it("fails closed when the resolver throws", () => {
    const root = fixture([{ text: "alpha", from: 78, to: 83 }]);
    const throwing: CaretResolver = () => {
      throw new Error("resolver exploded");
    };
    expect(() => cellPointAt(root, 0, 0, throwing)).not.toThrow();
    expect(cellPointAt(root, 0, 0, throwing)).toBeNull();
  });

  it("returns null when the point resolves outside this widget root", () => {
    const root = fixture([{ text: "alpha", from: 78, to: 83 }]);
    const outside = document.createElement("td");
    outside.dataset.cellFrom = "0";
    outside.dataset.cellTo = "3";
    outside.appendChild(document.createTextNode("xyz"));
    document.body.appendChild(outside);
    expect(cellPointAt(root, 0, 0, resolverFor(outside.firstChild as Node, 1))).toBeNull();
  });

  it("returns null when the point is in the widget but not in a cell (margin)", () => {
    const root = fixture([{ text: "alpha", from: 78, to: 83 }]);
    expect(cellPointAt(root, 0, 0, resolverFor(root, 0))).toBeNull();
  });

  it("returns null when a cell is missing its stamps", () => {
    const root = fixture([{ text: "alpha", from: 78, to: 83 }]);
    const td = root.querySelector("td") as HTMLElement;
    td.removeAttribute("data-cell-to");
    expect(cellPointAt(root, 0, 0, resolverFor(td.firstChild as Node, 2))).toBeNull();
  });

  // `Range.setEnd` throws IndexSizeError past the node's length (real DOM and
  // happy-dom alike — RangeUtility.validateBoundaryPoint), so an out-of-range
  // resolver offset fails CLOSED to "no exact mapping" rather than being
  // silently clamped to a position the pointer was never at.
  it("reports offset null for an out-of-range resolver offset", () => {
    const root = fixture([{ text: "alpha", from: 78, to: 83 }]);
    const text = root.querySelector("td")?.firstChild as Node;
    expect(cellPointAt(root, 0, 0, resolverFor(text, 99))).toEqual({
      cellFrom: 78,
      cellTo: 83,
      offset: null,
    });
  });

  it("passes the widget's OWN document to the resolver", () => {
    const root = fixture([{ text: "alpha", from: 78, to: 83 }]);
    let seen: Document | null = null;
    cellPointAt(root, 1, 2, (_x, _y, doc) => {
      seen = doc;
      return null;
    });
    expect(seen).toBe(root.ownerDocument);
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
