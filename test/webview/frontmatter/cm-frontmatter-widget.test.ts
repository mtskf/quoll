// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import {
  FrontmatterBlockWidget,
  parseFrontmatter,
} from "../../../src/webview/cm/frontmatter/frontmatter-widget.js";

describe("parseFrontmatter", () => {
  it("returns clean pairs for top-level `key: value` lines", () => {
    expect(parseFrontmatter("title: Hello\ndraft: true")).toEqual({
      kind: "pairs",
      rows: [
        { key: "title", value: "Hello" },
        { key: "draft", value: "true" },
      ],
    });
  });

  it("keeps a valueless key (`key:`) with an empty value", () => {
    expect(parseFrontmatter("tags:")).toEqual({
      kind: "pairs",
      rows: [{ key: "tags", value: "" }],
    });
  });

  it("skips blank lines between pairs", () => {
    expect(parseFrontmatter("a: 1\n\nb: 2")).toEqual({
      kind: "pairs",
      rows: [
        { key: "a", value: "1" },
        { key: "b", value: "2" },
      ],
    });
  });

  it.each([
    ["flow-mapping value", "config: {a: b}", "{a: b}"],
    ["flow-sequence value", "tags: [a, b]", "[a, b]"],
    ["a colon in the value", "time: 12:30", "12:30"],
    ["a URL with a # fragment (not a comment)", "url: https://x#frag", "https://x#frag"],
  ])("keeps a single clean pair with a verbatim value for %s", (_label, body, value) => {
    expect(parseFrontmatter(body)).toEqual({
      kind: "pairs",
      rows: [{ key: body.slice(0, body.indexOf(":")), value }],
    });
  });

  it.each([
    ["nested mapping", "author:\n  name: x"],
    ["a list item", "tags:\n  - a"],
    ["a top-level sequence of mappings", "authors:\n- name: Alice"],
    ["a bare flow mapping (no key)", "{a: b}"],
    ["an anchored key", "&x key: value"],
    ["a tagged key", "!!str key: val"],
    ["an alias key", "*x: value"],
    ["an aliased value", "copy: *x"],
    ["an anchored value", "base: &x hello"],
    ["a tagged value", "typed: !!str 12"],
    ["a block-scalar value with an indent indicator", "description: |2-"],
    ["a quoted key", '"quoted": val'],
    ["a comment line", "# a note\ntitle: x"],
    ["a value that is only a comment", "title: # note"],
    ["an inline comment in the value", "title: x # note"],
    ["a block-scalar header", "description: |"],
    ["key:value without a space", "title:x"],
  ])("falls back to raw for %s", (_label, body) => {
    expect(parseFrontmatter(body)).toEqual({ kind: "raw" });
  });

  it("returns raw for an empty body", () => {
    expect(parseFrontmatter("")).toEqual({ kind: "raw" });
  });
});

describe("FrontmatterBlockWidget — DOM structure (a11y, read-only)", () => {
  it("builds a role=region div with an aria-label and a <dl> (NOT an <hr>)", () => {
    const dom = new FrontmatterBlockWidget(
      "title: x\ndraft: true",
      "---\ntitle: x\ndraft: true\n---"
    ).toDOM();
    expect(dom.tagName).toBe("DIV");
    expect(dom.className).toBe("quoll-block quoll-frontmatter-block");
    expect(dom.getAttribute("role")).toBe("region");
    expect(dom.getAttribute("aria-label")).toBeTruthy();
    const dl = dom.querySelector("dl.quoll-frontmatter-list");
    expect(dl).not.toBeNull();
    expect(dl?.querySelectorAll("dt")).toHaveLength(2);
    expect(dl?.querySelectorAll("dd")).toHaveLength(2);
    expect((dl?.querySelector("dt") as HTMLElement).textContent).toBe("title");
    expect((dl?.querySelectorAll("dd")[0] as HTMLElement).textContent).toBe("x");
  });

  it("carries an aria-description hinting the caret-reveal edit affordance (a11y M3)", () => {
    // The region's reveal-to-edit action is pointer-only on the element (mousedown);
    // the canonical keyboard route is the caret model. Pin the SR discovery hint so
    // the region is not announced as a dead end. Non-vacuous: absent the attribute,
    // getAttribute returns null and both assertions fail.
    const dom = new FrontmatterBlockWidget(
      "title: x\ndraft: true",
      "---\ntitle: x\ndraft: true\n---"
    ).toDOM();
    const description = dom.getAttribute("aria-description");
    expect(description).toBeTruthy();
    expect(description).toMatch(/caret|edit/i);
  });

  it("renders a <pre> raw fallback for complex YAML (no misrepresentation)", () => {
    const dom = new FrontmatterBlockWidget(
      "author:\n  name: x",
      "---\nauthor:\n  name: x\n---"
    ).toDOM();
    expect(dom.querySelector("dl")).toBeNull();
    const pre = dom.querySelector("pre.quoll-frontmatter-raw");
    expect(pre).not.toBeNull();
    expect((pre as HTMLElement).textContent).toBe("author:\n  name: x");
  });

  it("eq() is keyed on slice", () => {
    const a = new FrontmatterBlockWidget("a: 1", "---\na: 1\n---");
    const same = new FrontmatterBlockWidget("a: 1", "---\na: 1\n---");
    const diff = new FrontmatterBlockWidget("a: 2", "---\na: 2\n---");
    expect(a.eq(same)).toBe(true);
    expect(a.eq(diff)).toBe(false);
  });

  it("ignoreEvent() returns true (atomic from CM's perspective)", () => {
    expect(new FrontmatterBlockWidget("a: 1", "---\na: 1\n---").ignoreEvent()).toBe(true);
  });
});
