// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { type Ctx, collectInline } from "../../../src/webview/cm/paste/html-to-markdown.js";
import {
  BOLD,
  CapExceeded,
  type InlineAtom,
  ITALIC,
} from "../../../src/webview/cm/paste/inline-runs.js";

const B = BOLD;
const I = ITALIC;

const freshCtx = (): Ctx => ({ nodes: 0, outLen: 0, emittedMarkdownSyntax: false });

function firstP(html: string): Element {
  const doc = new DOMParser().parseFromString(`<p>${html}</p>`, "text/html");
  const p = doc.querySelector("p");
  if (p === null) {
    throw new Error("fixture has no <p>");
  }
  return p;
}

function collect(html: string, ctx: Ctx = freshCtx()): InlineAtom[] {
  const out: InlineAtom[] = [];
  collectInline(firstP(html), 0, ctx, 0, out);
  return out;
}

describe("collectInline", () => {
  it("carries the enclosing style into a transparent span", () => {
    expect(collect("<b>A<span>B</span></b>")).toEqual([
      { kind: "text", text: "A", style: B },
      { kind: "text", text: "B", style: B },
    ]);
  });

  it("lets a tag's own style attribute cancel its emphasis", () => {
    expect(collect('<b><i>A</i></b><b style="font-weight:normal">x</b>')).toEqual([
      { kind: "text", text: "A", style: B | I },
      { kind: "text", text: "x", style: 0 },
    ]);
  });

  it("ignores a wrapper span's cancelling style", () => {
    expect(collect('<b><i>A</i></b><span style="font-weight:normal"><b>x</b></span>')).toEqual([
      { kind: "text", text: "A", style: B | I },
      { kind: "text", text: "x", style: B },
    ]);
  });

  it("keeps the style on a hard break", () => {
    expect(collect("<b>a<br>b</b>")).toEqual([
      { kind: "text", text: "a", style: B },
      { kind: "break", style: B },
      { kind: "text", text: "b", style: B },
    ]);
  });

  it("inlines a rejected link's label with the outer style", () => {
    expect(collect('<b><a href="javascript:x">t</a></b>')).toEqual([
      { kind: "text", text: "t", style: B },
    ]);
  });

  it("emits an allowed link as one atom with a link-relative label", () => {
    const ctx = freshCtx();
    expect(collect('<a href="https://e.x"><b>t</b></a>', ctx)).toEqual([
      {
        kind: "link",
        label: [{ kind: "text", text: "t", style: B }],
        destination: "https://e.x",
        style: 0,
      },
    ]);
    expect(ctx.emittedMarkdownSyntax).toBe(true);
  });

  it("encodes the destination as Markdown", () => {
    const [atom] = collect('<a href="https://x.com/a<b>c">t</a>');
    expect(atom.kind === "link" && atom.destination).toBe("https://x.com/a&lt;b&gt;c");
  });

  it("throws the cap error past the depth limit", () => {
    const html = `${"<span>".repeat(33)}x${"</span>".repeat(33)}`;
    expect(() => collect(html)).toThrow(CapExceeded);
  });
});
