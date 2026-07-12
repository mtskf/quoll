import { EditorState, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import {
  detectLeadingFrontmatterInState,
  leadingFrontmatterEnd,
} from "../../../src/webview/cm/frontmatter/detect.js";

function lfState(doc: string): EditorState {
  return EditorState.create({ doc });
}

// Production seeding (editor.ts) pre-splits on /\r\n?|\n/ and sets the CRLF
// lineSeparator; doc.line(n).text then carries no `\r`.
function crlfState(raw: string): EditorState {
  return EditorState.create({
    doc: Text.of(raw.split(/\r\n?|\n/)),
    extensions: [EditorState.lineSeparator.of("\r\n")],
  });
}

describe("detectLeadingFrontmatterInState", () => {
  it("detects a simple LF frontmatter block", () => {
    const span = detectLeadingFrontmatterInState(lfState("---\ntitle: x\n---\nbody\n"));
    expect(span).not.toBeNull();
    expect(span?.from).toBe(0);
    // `to` = end of the closer line (before its \n) = length of the substring
    // from doc start through the closing fence.
    expect(span?.to).toBe("---\ntitle: x\n---".length); // 16
    expect(span?.body).toBe("title: x");
  });

  it("returns null when line 1 is not a fence", () => {
    expect(detectLeadingFrontmatterInState(lfState("# heading\n---\n"))).toBeNull();
  });

  it("returns null for a leading `---` with no closer (CommonMark <hr> + prose)", () => {
    expect(detectLeadingFrontmatterInState(lfState("---\n\n# heading\n"))).toBeNull();
  });

  it("stops at the FIRST closer; later `---` lines are body/content", () => {
    const span = detectLeadingFrontmatterInState(lfState("---\na: 1\n---\nmore\n---\n"));
    expect(span?.body).toBe("a: 1");
    expect(span?.to).toBe("---\na: 1\n---".length); // 12 — end of the FIRST closer line
  });

  it("handles an empty body (`---` immediately followed by `---`)", () => {
    const span = detectLeadingFrontmatterInState(lfState("---\n---\n"));
    expect(span?.body).toBe("");
    expect(span?.to).toBe("---\n---".length); // 7
  });

  it("does NOT treat `--- x` (trailing text) as a fence opener", () => {
    expect(detectLeadingFrontmatterInState(lfState("--- x\ntitle: y\n---\n"))).toBeNull();
  });

  it("does NOT treat `----` (four dashes) as an opener", () => {
    expect(detectLeadingFrontmatterInState(lfState("----\nk: v\n----\n"))).toBeNull();
  });

  it("tolerates trailing spaces/tabs on opener and closer", () => {
    const span = detectLeadingFrontmatterInState(lfState("--- \nk: v\n---\t\nbody\n"));
    expect(span?.body).toBe("k: v");
  });

  it("is CRLF-correct: body is LF-joined, no stray \\r", () => {
    const span = detectLeadingFrontmatterInState(crlfState("---\r\ntitle: x\r\n---\r\nbody\r\n"));
    expect(span).not.toBeNull();
    expect(span?.body).toBe("title: x");
    expect(span?.body.includes("\r")).toBe(false);
  });

  it("joins a multi-line body with LF", () => {
    const span = detectLeadingFrontmatterInState(lfState("---\na: 1\nb: 2\n---\n"));
    expect(span?.body).toBe("a: 1\nb: 2");
  });
});

describe("leadingFrontmatterEnd", () => {
  it("returns the span end when frontmatter is present", () => {
    expect(leadingFrontmatterEnd(lfState("---\na: 1\n---\nx\n"))).toBe("---\na: 1\n---".length);
  });

  it("returns 0 when there is no frontmatter", () => {
    expect(leadingFrontmatterEnd(lfState("# heading\n"))).toBe(0);
  });
});
