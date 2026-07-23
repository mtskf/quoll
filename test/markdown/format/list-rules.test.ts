import { describe, expect, it } from "vitest";
import { applyEdits } from "../../../src/markdown/format/edit.js";
import { listRenumberEdits } from "../../../src/markdown/format/list-rules.js";
import { classifyDocument } from "../../../src/markdown/format/segment.js";

const run = (s: string) => applyEdits(s, listRenumberEdits(classifyDocument(s).orderedLists));

describe("listRenumberEdits", () => {
  it("renumbers sequentially, preserving the start", () =>
    expect(run("1. a\n1. b\n1. c\n")).toBe("1. a\n2. b\n3. c\n"));
  it("preserves a non-1 start", () => expect(run("3. a\n7. b\n2. c\n")).toBe("3. a\n4. b\n5. c\n"));
  it("preserves the ) delimiter", () => expect(run("1) a\n5) b\n")).toBe("1) a\n2) b\n"));
  it("bails when renumber would change marker width (de-nest guard)", () => {
    // 9. -> 10. would widen; leave the whole group untouched.
    const src = "9. a\n9. b\n9. c\n";
    expect(listRenumberEdits(classifyDocument(src).orderedLists)).toEqual([]);
  });
  it("renumbers nested lists independently when width-stable", () =>
    expect(run("1. a\n   1. x\n   1. y\n2. b\n")).toBe("1. a\n   1. x\n   2. y\n2. b\n"));
});
