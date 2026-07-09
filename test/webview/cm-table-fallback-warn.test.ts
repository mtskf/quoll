// Pins the dev-visible warning tableBlockField emits when its bounded source —
// tableSkeletonField — is not registered and it falls back to the unbounded
// full walk+parse (the PERF.md bounding invariant is then not held). A single
// test drives the whole warn-once lifecycle: registered → silent, first
// fallback → one warning, second fallback → still one (latch holds). Kept in
// its own file so the module-scoped warn-once latch starts fresh (vitest
// isolates module state per test file).
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { tableBlockField, tableSkeletonField } from "../../src/webview/cm/table/index.js";

const TABLE = "| H1 | H2 |\n| -- | -- |\n| a1 | a2 |";
const WARN_NEEDLE = "tableSkeletonField not registered";

/** Count of console.warn calls whose first arg mentions the missing field —
 *  filters out any unrelated warnings so the assertion pins OUR signal. */
function fallbackWarnings(spy: ReturnType<typeof vi.spyOn>): number {
  return spy.mock.calls.filter((c: unknown[]) => String(c[0]).includes(WARN_NEEDLE)).length;
}

describe("tableBlockField — missing tableSkeletonField fallback warning", () => {
  it("warns exactly once on the fallback path and never when the field is registered", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const base = [markdown({ base: markdownLanguage }), tableBlockField];

      // Registered → bounded path taken, no fallback, no warning.
      EditorState.create({ doc: TABLE, extensions: [...base, tableSkeletonField] });
      expect(fallbackWarnings(warn)).toBe(0);

      // Field absent → fallback fires → exactly one dev-visible warning.
      EditorState.create({ doc: TABLE, extensions: base });
      expect(fallbackWarnings(warn)).toBe(1);

      // Fallback again → the module-scoped latch holds; still exactly one.
      EditorState.create({ doc: TABLE, extensions: base });
      expect(fallbackWarnings(warn)).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });
});
