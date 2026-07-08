import { StateField } from "@codemirror/state";
import { ViewPlugin } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { fencedCodeCollapseField } from "../../src/webview/cm/fenced-code/fenced-code-collapse.js";
import { frontmatterBlockField } from "../../src/webview/cm/frontmatter/index.js";
import { imageBlockField } from "../../src/webview/cm/image/index.js";
import { tableBlockField } from "../../src/webview/cm/table/index.js";

// Block widgets emit block-level `Decoration.replace`, which CodeMirror accepts
// ONLY from a StateField — a ViewPlugin throws at runtime. That runtime throw is
// the sole enforcement today; nothing fails at CI time if one of these fields is
// rewritten as a ViewPlugin. This test pins the shape so the rule is caught
// statically. See CLAUDE.md "Block widgets MUST be StateFields, not ViewPlugins"
// and memory [[quoll-cm-block-widgets-must-be-statefield]].

/**
 * A block-widget field must be a StateField and must NOT be a ViewPlugin.
 * The `instanceof ViewPlugin` guard is redundant with `instanceof StateField`
 * (the classes are unrelated) but states the forbidden shape explicitly, so the
 * assertion reads as the rule it enforces.
 */
function isBlockStateField(value: unknown): boolean {
  return value instanceof StateField && !(value instanceof ViewPlugin);
}

const BLOCK_FIELDS: ReadonlyArray<readonly [string, unknown]> = [
  ["tableBlockField", tableBlockField],
  ["imageBlockField", imageBlockField],
  ["frontmatterBlockField", frontmatterBlockField],
  ["fencedCodeCollapseField", fencedCodeCollapseField],
];

describe("block widgets must be StateFields, not ViewPlugins", () => {
  for (const [name, field] of BLOCK_FIELDS) {
    it(`${name} is StateField-backed`, () => {
      expect(isBlockStateField(field)).toBe(true);
    });
  }

  it("non-vacuity: a ViewPlugin-shaped export is rejected by the guard", () => {
    // If any field above were (re)written as a ViewPlugin, its assertion would
    // fail exactly as this planted violation does.
    const plantedViewPlugin = ViewPlugin.define(() => ({}));
    expect(isBlockStateField(plantedViewPlugin)).toBe(false);
    // Sanity-check the guard's positive arm against a bare StateField too.
    const plantedStateField = StateField.define({ create: () => 0, update: (v) => v });
    expect(isBlockStateField(plantedStateField)).toBe(true);
  });
});
