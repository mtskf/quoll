import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { describe, expect, it } from "vitest";

import {
  hasLinkAncestor,
  inlineCodeInterior,
} from "../../src/webview/cm/code-ref/inline-code-ref.js";
import { fullTree } from "./helpers/full-tree.js";

// Directly pins the shared Lezer walks that keep the code-ref DECORATION
// (code-ref-reveal.ts) and the CLICK gate (code-ref-handlers.ts) in lockstep —
// both call these helpers, so a regression here silently diverges affordance
// from behaviour.
function firstInlineCode(doc: string): SyntaxNode {
  const state = EditorState.create({ doc, extensions: [markdown()] });
  const nodes: SyntaxNode[] = [];
  fullTree(state).iterate({
    enter: (n) => {
      if (n.name === "InlineCode") {
        nodes.push(n.node);
      }
    },
  });
  const node = nodes[0];
  if (node === undefined) {
    throw new Error("no InlineCode node found");
  }
  return node;
}

describe("inline-code-ref shared walks", () => {
  it("inlineCodeInterior returns the span between the backticks", () => {
    const doc = "see `src/foo.ts` end";
    const interior = inlineCodeInterior(firstInlineCode(doc));
    expect(interior).not.toBeNull();
    expect(doc.slice((interior as { from: number }).from, (interior as { to: number }).to)).toBe(
      "src/foo.ts"
    );
  });

  it("hasLinkAncestor is false for a standalone inline code span", () => {
    expect(hasLinkAncestor(firstInlineCode("see `src/foo.ts` end"))).toBe(false);
  });

  it("hasLinkAncestor is true for inline code nested inside a link", () => {
    expect(hasLinkAncestor(firstInlineCode("[`src/foo.ts`](other.md)"))).toBe(true);
  });
});
