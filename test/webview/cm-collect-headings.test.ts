import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  collectHeadings,
  headingSlugSource,
  headingText,
  slugifyHeadingText,
} from "../../src/webview/cm/headings.js";
import { fullTree } from "./helpers/full-tree.js";

function stateOf(doc: string) {
  return EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
}

function treeOf(doc: string) {
  return fullTree(stateOf(doc));
}

describe("collectHeadings", () => {
  it("collects ATX headings in document order with level/from/to", () => {
    const hs = collectHeadings(treeOf("# a\n\n### c\n\ntext\n"));
    expect(hs.map((h) => h.level)).toEqual([1, 3]);
    expect(hs[0].from).toBe(0);
    expect(hs.every((h) => h.to > h.from)).toBe(true);
  });
  it("ignores non-heading nodes (fenced code, plain text)", () => {
    expect(
      collectHeadings(treeOf("```\n# not a heading\n```\n\n## real\n")).map((h) => h.level)
    ).toEqual([2]);
  });
});

describe("headingText", () => {
  it("strips the ATX opener and an optional closing run", () => {
    expect(headingText("## Getting started")).toBe("Getting started");
    expect(headingText("###   Spaced   ")).toBe("Spaced");
    expect(headingText("## Closed ##")).toBe("Closed");
    expect(headingText("#")).toBe("");
  });

  it("leaves `# #` as a stray hash — which slugs to nothing downstream", () => {
    // Pins the KNOWN divergence from lint/rules/duplicate-heading-text.ts's
    // copy, which strips the closing run FIRST and yields "". Both reach the
    // same place for our purposes (second assertion), so the outline's
    // long-standing behaviour is moved here unchanged rather than "fixed".
    expect(headingText("# #")).toBe("#");
    expect(slugifyHeadingText(headingText("# #"))).toBe("");
  });
});

describe("slugifyHeadingText", () => {
  it("lowercases, drops punctuation and hyphenates whitespace (GitHub-style)", () => {
    expect(slugifyHeadingText("Getting Started")).toBe("getting-started");
    expect(slugifyHeadingText("What's new, really?")).toBe("whats-new-really");
    expect(slugifyHeadingText("  Trim   me  ")).toBe("trim-me");
    expect(slugifyHeadingText("snake_case and dash-case")).toBe("snake_case-and-dash-case");
  });

  it("keeps letters, numbers and marks from non-Latin scripts", () => {
    expect(slugifyHeadingText("設計メモ")).toBe("設計メモ");
    expect(slugifyHeadingText("Café Ünicode")).toBe("café-ünicode");
  });

  it("normalises to NFC so a decomposed heading matches a composed fragment", () => {
    // A macOS-pasted heading can arrive NFD ("e" + U+0301) while the fragment
    // is NFC. Same function on both sides only helps if it canonicalises first.
    expect(slugifyHeadingText("Café")).toBe(slugifyHeadingText("Café"));
    expect(slugifyHeadingText("Café")).toBe("café");
  });

  it("drops emoji and symbol runs rather than transliterating them", () => {
    expect(slugifyHeadingText("🚧 Work in progress")).toBe("work-in-progress");
  });

  it("slugs emphasis and inline code the way GitHub does", () => {
    expect(slugifyHeadingText("Some **bold** heading")).toBe("some-bold-heading");
    expect(slugifyHeadingText("The `foo` API")).toBe("the-foo-api");
  });

  it("slugs whatever string it is handed — raw link source included", () => {
    // NOT a divergence pin any more: it is the statement that this function
    // makes no claim about its INPUT. Handed raw source it leaks the
    // destination, which is exactly why the fragment-link resolver feeds it
    // headingSlugSource (below) rather than headingText.
    expect(slugifyHeadingText("A [link](b)")).toBe("a-linkb");
  });

  it("is idempotent on an already-slugged string", () => {
    const once = slugifyHeadingText("Some **bold** heading!");
    expect(slugifyHeadingText(once)).toBe(once);
  });

  it("returns an empty string for a text with nothing sluggable", () => {
    expect(slugifyHeadingText("!!!")).toBe("");
    expect(slugifyHeadingText("")).toBe("");
  });
});

describe("headingSlugSource", () => {
  /** Slug the SOLE heading of `doc` the way the fragment-link resolver does. */
  function slugOf(doc: string): string {
    const state = stateOf(doc);
    const tree = fullTree(state);
    const [heading] = collectHeadings(tree);
    expect(heading).toBeDefined();
    return slugifyHeadingText(headingSlugSource(state, tree, heading.from, heading.to));
  }

  it("drops the ATX marks without a regex — HeaderMark covers opener and closer", () => {
    expect(slugOf("## Getting Started")).toBe("getting-started");
    expect(slugOf("## Closed ##")).toBe("closed");
  });

  it("slugs a link's TEXT, not its destination (the anchor GitHub produces)", () => {
    expect(slugOf("# A [link](b)")).toBe("a-link");
  });

  it("drops emphasis, code and strikethrough marks while keeping their content", () => {
    expect(slugOf("## The `foo` API")).toBe("the-foo-api");
    expect(slugOf("### Some **bold** heading")).toBe("some-bold-heading");
  });

  it("drops strikethrough marks and raw HTML tags", () => {
    expect(slugOf("#### With ~~strike~~ and <em>html</em>")).toBe("with-strike-and-html");
  });

  it("keeps a URL that IS the content, and drops one that is a destination", () => {
    // `URL` is markup only under a Link/Image. GFM emits the same node name for
    // an autolink's inner text and for a bare URL literal, where those bytes are
    // what the reader sees — and what GitHub slugs. Dropping `URL` by name made
    // a heading that is nothing but a URL produce the empty slug, i.e. no anchor
    // at all; these three pin the parent gate that fixed it.
    expect(slugOf("# See https://example.com bare")).toBe("see-httpsexamplecom-bare");
    expect(slugOf("# See <https://example.com>")).toBe("see-httpsexamplecom");
    expect(slugOf("# https://example.com/docs")).toBe("httpsexamplecomdocs");
    // …while a real destination still never reaches the slug.
    expect(slugOf("# A [link](https://example.com)")).toBe("a-link");
  });

  it("keeps a URL that is the LINK TEXT while still dropping the destination", () => {
    // GFM autolinks inside link text and image alt text, so those URL nodes
    // share the destination's parent and only the preceding mark tells them
    // apart. Gating on the parent alone erased both and left no anchor at all.
    expect(slugOf("# [https://example.com](dest)")).toBe("httpsexamplecom");
    expect(slugOf("# ![see https://alt.example](u.png)")).toBe("see-httpsaltexample");
  });

  it("drops a link title — a tooltip is never rendered text", () => {
    expect(slugOf('# A [link](b "Title")')).toBe("a-link");
  });

  it("drops an HTML comment, matching GitHub rather than Quoll's rendering", () => {
    // The one place the exclusion set follows GitHub over "what Quoll hides":
    // nothing conceals a comment in the editor, but GitHub's anchor omits it.
    expect(slugOf("# A <!-- hidden --> C")).toBe("a-c");
  });

  it("keeps an image's alt text and drops its destination", () => {
    expect(slugOf("##### ![img](u.png) caption")).toBe("img-caption");
  });

  it("yields nothing for a heading that is only marks", () => {
    // `# #` is two HeaderMarks around a space — no content, so no anchor, and
    // buildSlugIndex skips it.
    expect(slugOf("# #")).toBe("");
  });

  it("stays total when the span is not inside the document", () => {
    // Same hazard as link-resolve.ts's index guard: a stale tree over a
    // shortened document. Slicing would throw; this returns "".
    const state = stateOf("# Alpha");
    const tree = fullTree(state);
    expect(headingSlugSource(state, tree, 0, state.doc.length + 50)).toBe("");
    expect(headingSlugSource(state, tree, -1, 3)).toBe("");
    expect(headingSlugSource(state, tree, 5, 2)).toBe("");
  });
});
