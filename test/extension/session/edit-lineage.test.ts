import { describe, expect, it } from "vitest";

import { createEditLineage } from "../../../src/extension/session/edit-lineage.js";

describe("edit lineage", () => {
  it("answers null before anything was handed", () => {
    expect(createEditLineage().lineageSince("a")).toBeNull();
  });

  it("proves the handed text EOL-insensitively", () => {
    const l = createEditLineage();
    l.noteHandedText("a\nb", 1, 1);
    expect(l.lineageSince("a\nb")).toBe(1);
    // The EOL-mode switch: same text, new line endings.
    expect(l.lineageSince("a\r\nb")).toBe(1);
  });

  it("does not move `since` on a same-text resend", () => {
    // A ready / visible-edge resend of the same text at a later label must
    // keep an Edit on the earlier label valid.
    const l = createEditLineage();
    l.noteHandedText("a\nb", 1, 1);
    l.noteHandedText("a\r\nb", 2, 2);
    expect(l.lineageSince("a\r\nb")).toBe(1);
  });

  it("re-anchors on a text change, so older labels stop matching", () => {
    const l = createEditLineage();
    l.noteHandedText("a", 1, 1);
    l.noteHandedText("ab", 2, 2);
    expect(l.lineageSince("ab")).toBe(2);
    // An external revert to the old text is not the lineage's text.
    expect(l.lineageSince("a")).toBeNull();
  });

  it("never attributes live text to a past label", () => {
    // Rejected-draft replay at label 1 while an external edit (live v2) is
    // still in the documentChanged debounce.
    const l = createEditLineage();
    l.noteHandedText("A", 1, 1);
    l.noteHandedText("B", 1, 2);
    expect(l.lineageSince("B")).toBeNull();
    expect(l.lineageSince("A")).toBe(1);
  });

  it("keeps the lineage on an EOL-only label/live mismatch", () => {
    const l = createEditLineage();
    l.noteHandedText("a\nb", 1, 1);
    l.noteHandedText("a\r\nb", 1, 2);
    expect(l.lineageSince("a\r\nb")).toBe(1);
  });

  it("answers null after a reset", () => {
    const l = createEditLineage();
    l.noteHandedText("a", 1, 1);
    l.reset();
    expect(l.lineageSince("a")).toBeNull();
  });
});
