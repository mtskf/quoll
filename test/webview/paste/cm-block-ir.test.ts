import { describe, expect, it } from "vitest";
import type { BlockNode } from "../../../src/webview/cm/paste/block-ir.js";

function rawNodeIsRejected(): void {
  // @ts-expect-error Raw Markdown is not a block node.
  const node: BlockNode = { kind: "raw", markdown: "x" };
  void node;
}

describe("block IR", () => {
  it("keeps the type contract compile-checked", () => {
    expect(rawNodeIsRejected).toBeTypeOf("function");
  });
});

describe("block leaf serialization", () => {
  it("renders leaf kinds and derives their richness", async () => {
    const { serializeBlockNodes } = await import("../../../src/webview/cm/paste/block-ir.js");
    expect(
      serializeBlockNodes([{ kind: "paragraph", inline: { markdown: "plain", rich: false } }])
    ).toEqual({ markdown: "plain", rich: false });
    expect(
      serializeBlockNodes([
        { kind: "heading", level: 2, inline: { markdown: "title #", rich: false } },
      ])
    ).toEqual({ markdown: "## title \\#", rich: true });
    expect(serializeBlockNodes([{ kind: "code", body: "```", lang: "ts" }])).toEqual({
      markdown: "````ts\n```\n````",
      rich: true,
    });
    expect(serializeBlockNodes([{ kind: "table", gfm: "|  |", content: "empty" }])).toEqual({
      markdown: "|  |",
      rich: false,
    });
    expect(
      serializeBlockNodes([{ kind: "table", gfm: "| x |", content: "visible" }, { kind: "rule" }])
    ).toEqual({ markdown: "| x |\n\n---", rich: true });
  });
});

describe("block container serialization", () => {
  it("uses surviving kinds for spacing and ordinals", async () => {
    const { serializeBlockNodes } = await import("../../../src/webview/cm/paste/block-ir.js");
    const p = (markdown: string): BlockNode => ({
      kind: "paragraph",
      inline: { markdown, rich: false },
    });
    const list: BlockNode = {
      kind: "list",
      ordered: true,
      start: 1,
      hasOwnText: true,
      items: [[p("a"), p("- literal")], [p("\u200d")], [p("b")]],
    };
    expect(serializeBlockNodes([list])).toEqual({
      markdown: "1. a\n\n   - literal\n2. b",
      rich: true,
    });
    const nested: BlockNode = {
      kind: "list",
      ordered: false,
      start: 0,
      hasOwnText: true,
      items: [
        [p("a"), { kind: "list", ordered: false, start: 0, hasOwnText: true, items: [[p("b")]] }],
      ],
    };
    expect(serializeBlockNodes([nested]).markdown).toBe("- a\n  - b");
  });
  it("drops containers whose only content is invisible, in both halves of the class", async () => {
    const { serializeBlockNodes } = await import("../../../src/webview/cm/paste/block-ir.js");
    const p = (markdown: string): BlockNode => ({
      kind: "paragraph",
      inline: { markdown, rich: false },
    });
    // U+3164 is Default_Ignorable only; U+0600 is Cf only — each half must count as blank.
    for (const ch of ["ㅤ", "؀"]) {
      expect(
        serializeBlockNodes([{ kind: "quote", hasOwnText: false, children: [p(ch)] }]).markdown
      ).toBe("");
    }
  });
  it("skips an emptied block between siblings without a stray separator", async () => {
    const { serializeBlockNodes } = await import("../../../src/webview/cm/paste/block-ir.js");
    const p = (markdown: string): BlockNode => ({
      kind: "paragraph",
      inline: { markdown, rich: false },
    });
    expect(
      serializeBlockNodes([p("a"), { kind: "quote", hasOwnText: false, children: [p("‍")] }, p("b")])
        .markdown
    ).toBe("a\n\nb");
  });
  it("skips an emptied child inside a list item", async () => {
    const { serializeBlockNodes } = await import("../../../src/webview/cm/paste/block-ir.js");
    const p = (markdown: string): BlockNode => ({
      kind: "paragraph",
      inline: { markdown, rich: false },
    });
    expect(
      serializeBlockNodes([
        {
          kind: "list",
          ordered: false,
          start: 0,
          hasOwnText: true,
          items: [[{ kind: "quote", hasOwnText: false, children: [p("‍")] }, p("x")]],
        },
      ]).markdown
    ).toBe("- x");
  });
  it("keeps nested spacer quotes non-rich", async () => {
    const { serializeBlockNodes } = await import("../../../src/webview/cm/paste/block-ir.js");
    const quote: BlockNode = {
      kind: "quote",
      hasOwnText: false,
      children: [{ kind: "table", gfm: "|  |\n| --- |", content: "empty" }],
    };
    expect(serializeBlockNodes([quote])).toEqual({ markdown: "> |  |\n> | --- |", rich: false });
  });
});
