// @vitest-environment happy-dom
// What a cell renders when nothing special is going on: plain text, inline code
// spans, backslash escapes, HTML-escaping of raw `<`/`>`/`&`, and mixed content
// in source order.
// The second describe pins those same renders through the one property innerHTML
// CANNOT see — that adjacent text, escape, inert-source and leftover-delimiter
// runs collapse into ONE text node. `a\|b` appears in both: above as the markup
// `a|b`, below as a single text node. A renderer that emitted three nodes whose
// text happened to concatenate to `a|b` would satisfy the first and fail the
// second, which is why the two live together.
import { describe, expect, it } from "vitest";

import { renderCellInline } from "../../../src/webview/cm/table/cell-render.js";
import { html, htmlWithoutTooltip } from "./helpers/cell-render-fixtures.js";

describe("renderCellInline — text, code spans and escapes", () => {
  it("renders plain text as a single text node", () => {
    const nodes = renderCellInline("hello");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].nodeType).toBe(Node.TEXT_NODE);
    expect(nodes[0].textContent).toBe("hello");
  });

  it("returns an empty array for an empty string", () => {
    expect(renderCellInline("")).toEqual([]);
  });

  it("renders inline `code` as <code>", () => {
    const nodes = renderCellInline("use `git diff`");
    expect(html(nodes)).toBe("use <code>git diff</code>");
  });

  // CommonMark §6.1: a multi-backtick opener with no matching closing run
  // renders literally. The C6b scope is single-backtick spans only; the
  // pre-fix code greedily paired the first two backticks of `` `` `` and
  // emitted an empty `<code></code>`. Multi-backtick code spans + CommonMark
  // code normalization are deferred out of C6c scope — multi-backtick runs
  // fall through to literal text indefinitely until that scope lands.
  it("renders a double-backtick `` `` `` sequence as literal text (no empty <code>)", () => {
    expect(html(renderCellInline("``"))).toBe("``");
    expect(html(renderCellInline("a `` b"))).toBe("a `` b");
  });

  it("decodes escaped pipe `\\|` to a literal `|` in text", () => {
    const nodes = renderCellInline("a\\|b");
    expect(html(nodes)).toBe("a|b");
  });

  it("HTML-escapes raw `<` / `>` / `&` in plain text", () => {
    const nodes = renderCellInline("a < b & c > d");
    expect(html(nodes)).toBe("a &lt; b &amp; c &gt; d");
  });

  it("renders mixed content in source order", () => {
    const nodes = renderCellInline("pre [link](https://e.test) mid `code` end");
    expect(htmlWithoutTooltip(nodes)).toBe(
      'pre <a href="https://e.test" rel="noopener noreferrer">link</a> mid <code>code</code> end'
    );
  });
});

// renderReadonly merging is the part innerHTML CANNOT see — adjacent text /
// escape / inert-source / leftover-delimiter runs must collapse to ONE text
// node. Pin it by node count, not innerHTML (Codex plan review Conf 92).
describe("renderReadonly text-node topology (merging is not vacuous)", () => {
  it("merges an escape into surrounding text (`a\\|b` -> one text node `a|b`)", () => {
    const nodes = renderCellInline("a\\|b");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].nodeType).toBe(Node.TEXT_NODE);
    expect(nodes[0].textContent).toBe("a|b");
  });
  it("merges an inert unsafe construct into surrounding text (one node)", () => {
    const nodes = renderCellInline("x[bad](javascript:1)y");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].textContent).toBe("x[bad](javascript:1)y");
  });
  it("merges unmatched delimiters into text (`x**unclosed` -> one node)", () => {
    const nodes = renderCellInline("x**unclosed");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].textContent).toBe("x**unclosed");
  });
  it("merges an escaped pipe inside emphasis into one text child of <em>", () => {
    const nodes = renderCellInline("*a\\|b*");
    expect(nodes).toHaveLength(1);
    expect((nodes[0] as Element).tagName).toBe("EM");
    expect(nodes[0].childNodes).toHaveLength(1);
    expect(nodes[0].textContent).toBe("a|b");
  });
});
