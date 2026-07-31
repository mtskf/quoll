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
  // Builds `safeListCount` heading-separated, collision-free bullet lists plus
  // one final colliding list (`* --`), for exercising the MAX_PESSIMISTIC_GROUPS
  // boundary (total groups = safeListCount + 1 collision).
  const docWithGroups = (safeListCount: number) => {
    const safe = Array.from({ length: safeListCount }, (_, i) => `# h${i}\n\n* item${i}\n`).join(
      "\n"
    );
    return `${safe}\n# collide\n\n* --\n`;
  };
  it("runs the pessimistic pass at exactly the group budget (boundary, not >)", () => {
    // 99 safe lists + 1 collision = 100 groups == MAX_PESSIMISTIC_GROUPS (not > it)
    expect(edits(docWithGroups(99)).length).toBeGreaterThan(0); // within budget -> safe lists still unified
  });
  it("fails closed one past the group budget", () => {
    // 100 safe lists + 1 collision = 101 groups > MAX_PESSIMISTIC_GROUPS
    expect(edits(docWithGroups(100))).toEqual([]);
  });
});
