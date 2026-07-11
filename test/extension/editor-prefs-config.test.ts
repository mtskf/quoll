import { describe, expect, it } from "vitest";
import {
  isRelevantConfigChange,
  readEditorPref,
  readEditorPrefs,
} from "../../src/extension/editor-prefs-config.js";

describe("readEditorPref", () => {
  it("returns the stored id when it is a known enum value", () => {
    const get = (_k: string, _d: string) => "serif";
    expect(readEditorPref("quoll.editor.fontFamily", get)).toBe("serif");
  });

  it("returns the default when config is absent (get echoes the default)", () => {
    const get = (_k: string, def: string) => def; // VS Code returns `def` when unset
    expect(readEditorPref("quoll.editor.fontFamily", get)).toBe("default");
    expect(readEditorPref("quoll.editor.lineHeight", get)).toBe("cozy");
    expect(readEditorPref("quoll.editor.contentWidth", get)).toBe("medium");
  });

  it("falls back to the default on a corrupt / non-enum stored value", () => {
    const get = (_k: string, _d: string) => "garbage";
    expect(readEditorPref("quoll.editor.fontSize", get)).toBe("default");
  });
});

describe("readEditorPrefs", () => {
  it("returns all four fields", () => {
    const get = (k: string, _d: string) =>
      k === "quoll.editor.fontSize" ? "large" : "garbage-falls-to-default";
    expect(readEditorPrefs(get)).toEqual({
      fontFamily: "default",
      fontSize: "large",
      lineHeight: "cozy",
      contentWidth: "medium",
    });
  });
});

describe("isRelevantConfigChange", () => {
  const URI = { toString: () => "file:///doc.md" }; // stand-in for a vscode.Uri

  it("checks the 4 preset keys WITH the document uri (resource-scoped)", () => {
    const seen: Array<[string, unknown]> = [];
    const e = {
      affectsConfiguration: (section: string, scope?: unknown) => {
        seen.push([section, scope]);
        return false;
      },
    };
    isRelevantConfigChange(e, URI, ["quoll.lint.gutter.enabled", "quoll.editor.spellcheck"]);
    // Every preset-key call carried the document uri as the 2nd arg.
    for (const key of [
      "quoll.editor.fontFamily",
      "quoll.editor.fontSize",
      "quoll.editor.lineHeight",
      "quoll.editor.contentWidth",
    ]) {
      expect(seen).toContainEqual([key, URI]);
    }
  });

  it("checks the boolean keys UNSCOPED (no uri arg)", () => {
    const seen: Array<[string, unknown]> = [];
    const e = {
      affectsConfiguration: (section: string, scope?: unknown) => {
        seen.push([section, scope]);
        return false;
      },
    };
    isRelevantConfigChange(e, URI, ["quoll.lint.gutter.enabled", "quoll.editor.spellcheck"]);
    expect(seen).toContainEqual(["quoll.lint.gutter.enabled", undefined]);
    expect(seen).toContainEqual(["quoll.editor.spellcheck", undefined]);
  });

  it("is true when a resource-scoped preset key is affected, false otherwise", () => {
    const only = (match: string, scoped: boolean) => ({
      affectsConfiguration: (section: string, scope?: unknown) =>
        section === match && (scoped ? scope === URI : scope === undefined),
    });
    expect(
      isRelevantConfigChange(only("quoll.editor.fontSize", true), URI, ["quoll.editor.spellcheck"])
    ).toBe(true);
    expect(
      isRelevantConfigChange(only("quoll.editor.spellcheck", false), URI, [
        "quoll.editor.spellcheck",
      ])
    ).toBe(true);
    expect(
      isRelevantConfigChange(only("unrelated.key", false), URI, ["quoll.editor.spellcheck"])
    ).toBe(false);
  });
});
