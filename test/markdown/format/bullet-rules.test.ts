import { describe, expect, it } from "vitest";
import { bulletUnifyEdits } from "../../../src/markdown/format/bullet-rules.js";
import { applyEdits } from "../../../src/markdown/format/edit.js";
import { classifyDocument } from "../../../src/markdown/format/segment.js";

const run = (s: string) => applyEdits(s, bulletUnifyEdits(s, classifyDocument(s).bulletLists));
const edits = (s: string) => bulletUnifyEdits(s, classifyDocument(s).bulletLists);

describe("bulletUnifyEdits", () => {
  it("unifies a standalone * list to -", () => expect(run("* a\n* b\n")).toBe("- a\n- b\n"));
  it("unifies a standalone + list to -", () => expect(run("+ a\n+ b\n")).toBe("- a\n- b\n"));
  it("is a no-op on an already-- list", () => expect(edits("- a\n- b\n")).toEqual([]));
  it("leaves adjacent different-marker lists untouched (merge guard)", () =>
    expect(edits("* a\n+ b\n")).toEqual([]));
  it("leaves blank-separated different-marker lists untouched (tight/loose guard)", () =>
    expect(edits("* a\n\n- b\n")).toEqual([]));
  it("leaves blockquote-adjacent lists untouched (QuoteMark between)", () =>
    expect(edits("> * a\n> - b\n")).toEqual([]));
  it("unifies lists separated by a heading (not adjacent)", () =>
    expect(run("* a\n\n# h\n\n+ b\n")).toBe("- a\n\n# h\n\n- b\n"));
  it("unifies the outer list but not nested adjacent lists", () =>
    expect(run("* a\n  + x\n  - y\n")).toBe("- a\n  + x\n  - y\n"));
  it("unifies a standalone list inside a blockquote", () =>
    expect(run("> * a\n> * b\n")).toBe("> - a\n> - b\n"));
  // Per-list oracle: a marker->- rewrite that would create a thematic break must
  // be skipped (`* --` / `- --` is a HorizontalRule, not a list item).
  it("leaves a thematic-break-colliding item untouched (* --)", () =>
    expect(edits("* --\n")).toEqual([]));
  it("leaves a thematic-break-colliding item untouched (+ - -)", () =>
    expect(edits("+ - -\n")).toEqual([]));
  it("skips only the colliding list, still unifies unrelated safe lists", () =>
    expect(run("* good\n\n# separator\n\n* a\n* --\n")).toBe(
      "- good\n\n# separator\n\n* a\n* --\n"
    ));
  it("fails closed (no-op) when a colliding document exceeds the pessimistic group budget", () => {
    // >100 separate adjacency-safe bullet lists (heading-separated) + one collision.
    const lists = Array.from({ length: 101 }, (_, i) => `# h${i}\n\n* item${i}\n`).join("\n");
    const src = `${lists}\n# collide\n\n* --\n`;
    expect(edits(src)).toEqual([]); // budget exceeded -> whole rule no-ops
  });
  it("still unifies a colliding document with few groups (within budget)", () => {
    // sanity: below the budget, the pessimistic path still runs and skips only the collision
    expect(run("* good\n\n# s\n\n* a\n* --\n")).toBe("- good\n\n# s\n\n* a\n* --\n");
  });
});
