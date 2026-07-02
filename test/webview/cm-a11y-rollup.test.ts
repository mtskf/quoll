// @vitest-environment happy-dom
//
// C8 part (c): the single a11y roll-up. One file asserts the accessible
// contract of every interactive widget surface (checkbox, table grid, image,
// frontmatter metadata block) so "no surface is missed". Per-widget tests
// keep their own detailed coverage; this pins the cross-cutting contract.
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import { parseTable } from "../../src/markdown/table/index.js"; // match cm-table-widget.test.ts import
import type { AllowlistedUrl } from "../../src/markdown/url-allowlist.js";
import { CheckboxWidget } from "../../src/webview/cm/decorations/task-checkbox-widget.js";
import { FrontmatterBlockWidget } from "../../src/webview/cm/frontmatter/frontmatter-widget.js";
import { ImageBlockWidget } from "../../src/webview/cm/image/image-widget.js";
import { TableBlockWidget } from "../../src/webview/cm/table/table-widget.js";

const url = (s: string): AllowlistedUrl => s as AllowlistedUrl;
// Render-only stub: a no-op dispatch plus a real (empty) EditorState —
// TableBlockWidget.toDOM reads the quollResourceBaseUri facet from
// view.state (no facet value → "" → relative images inert).
const mockView = { state: EditorState.create({}), dispatch: () => {} } as unknown as EditorView;

describe("C8 a11y roll-up — task checkbox (C5)", () => {
  it("exposes role=checkbox + aria-checked + accessible name + tabindex", () => {
    const el = new CheckboxWidget(false, 2, "alpha").toDOM(mockView);
    expect(el.getAttribute("role")).toBe("checkbox");
    expect(el.getAttribute("aria-checked")).toBe("false");
    expect(el.getAttribute("aria-label")).toContain("alpha");
    expect(el.tabIndex).toBe(0);
  });
  it("reflects checked state in aria-checked", () => {
    expect(new CheckboxWidget(true, 2, "x").toDOM(mockView).getAttribute("aria-checked")).toBe(
      "true"
    );
  });
});

describe("C8 a11y roll-up — table grid (C6d)", () => {
  it("renders native table semantics with scope=col headers", () => {
    const src = "| H1 | H2 |\n| -- | -- |\n| a1 | a2 |";
    const table = parseTable(src, 0, src.length);
    if (table === null) {
      throw new Error("fixture must parse");
    }
    const dom = new TableBlockWidget(table, src, 0, 0).toDOM(mockView);
    expect(dom.querySelector("table")).not.toBeNull();
    const ths = dom.querySelectorAll("thead th");
    expect(ths.length).toBe(2);
    for (const th of ths) {
      expect(th.getAttribute("scope")).toBe("col");
    }
  });
});

describe("C8 a11y roll-up — image (C7)", () => {
  it("carries the markdown alt on a live <img>", () => {
    const dom = new ImageBlockWidget(
      "my alt",
      url("https://x.test/a.png"),
      "![my alt](https://x.test/a.png)",
      0
    ).toDOM(mockView);
    expect(dom.querySelector("img")?.alt).toBe("my alt");
  });
  it("labels a blocked image placeholder (role=img + aria-label)", () => {
    const dom = new ImageBlockWidget("diagram", null, "![diagram](javascript:alert(1))", 0).toDOM(
      mockView
    );
    const ph = dom.querySelector(".quoll-image-blocked");
    expect(ph?.getAttribute("role")).toBe("img");
    expect(ph?.getAttribute("aria-label")).toBe("Blocked image: diagram");
  });
});

describe("C8 a11y roll-up — frontmatter metadata block (C8a)", () => {
  it("renders a labelled region (NOT an hr) with a definition list", () => {
    const dom = new FrontmatterBlockWidget(
      "title: x\ndraft: true",
      "---\ntitle: x\ndraft: true\n---"
    ).toDOM();
    expect(dom.getAttribute("role")).toBe("region");
    expect(dom.getAttribute("aria-label")).toBe("Document metadata");
    expect(dom.querySelector("dl.quoll-frontmatter-list")).not.toBeNull();
    expect(dom.querySelector("hr")).toBeNull();
  });
});
