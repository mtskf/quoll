import { describe, expect, it } from "vitest";
import { TabInputCustom, TabInputText } from "vscode";
import {
  classifyOpenedTab,
  hasSiblingInOtherSurface,
  planRestore,
} from "../../src/extension/surface/surface-restore-watcher.js";

const quollVt = "quoll.editMarkdown";
const mdUri = { toString: () => "file:///a.md", path: "/a.md" } as never;
const txtUri = { toString: () => "file:///a.txt", path: "/a.txt" } as never;

describe("classifyOpenedTab", () => {
  it("classifies a Quoll custom tab as the quoll surface", () => {
    expect(classifyOpenedTab(new TabInputCustom(mdUri, quollVt), quollVt)).toEqual({
      surface: "quoll",
      uri: mdUri,
    });
  });

  it("classifies a markdown text tab as the text surface", () => {
    expect(classifyOpenedTab(new TabInputText(mdUri), quollVt)).toEqual({
      surface: "text",
      uri: mdUri,
    });
  });

  it("ignores a custom tab with a different viewType", () => {
    expect(classifyOpenedTab(new TabInputCustom(mdUri, "other.editor"), quollVt)).toBeNull();
  });

  it("ignores a non-markdown text tab", () => {
    expect(classifyOpenedTab(new TabInputText(txtUri), quollVt)).toBeNull();
  });

  it("ignores an unknown input kind", () => {
    expect(classifyOpenedTab({}, quollVt)).toBeNull();
    expect(classifyOpenedTab(undefined, quollVt)).toBeNull();
  });
});

describe("hasSiblingInOtherSurface", () => {
  const textInput = new TabInputText(mdUri);
  const quollInput = new TabInputCustom(mdUri, quollVt);
  const otherMd = { toString: () => "file:///b.md", path: "/b.md" } as never;

  it("finds a Quoll sibling when a text tab is shown", () => {
    expect(hasSiblingInOtherSurface([quollInput], "file:///a.md", "text", quollVt)).toBe(true);
  });

  it("finds a text sibling when a Quoll tab is shown", () => {
    expect(hasSiblingInOtherSurface([textInput], "file:///a.md", "quoll", quollVt)).toBe(true);
  });

  it("does not count a tab in the SAME surface as a sibling", () => {
    expect(hasSiblingInOtherSurface([textInput], "file:///a.md", "text", quollVt)).toBe(false);
    expect(hasSiblingInOtherSurface([quollInput], "file:///a.md", "quoll", quollVt)).toBe(false);
  });

  it("does not count a different uri as a sibling", () => {
    const otherQuoll = new TabInputCustom(otherMd, quollVt);
    expect(hasSiblingInOtherSurface([otherQuoll], "file:///a.md", "text", quollVt)).toBe(false);
  });

  it("is false for an empty tab list or only unrelated inputs", () => {
    expect(hasSiblingInOtherSurface([], "file:///a.md", "text", quollVt)).toBe(false);
    expect(hasSiblingInOtherSurface([{}, undefined], "file:///a.md", "text", quollVt)).toBe(false);
  });
});

describe("planRestore (pure)", () => {
  it("skips a dirty doc regardless of target (passive restore never saves)", () => {
    expect(planRestore("text", true, true)).toBe("skip");
    expect(planRestore("quoll", true, true)).toBe("skip");
  });

  it("reopens in text when text is remembered and the doc is clean", () => {
    expect(planRestore("text", false, false)).toBe("reopen-text");
  });

  it("reopens in Quoll when quoll is remembered, clean, and editable", () => {
    expect(planRestore("quoll", false, true)).toBe("reopen-quoll");
  });

  it("skips a Quoll restore when the doc cannot be edited with Quoll (readonly/non-file)", () => {
    expect(planRestore("quoll", false, false)).toBe("skip");
  });
});
