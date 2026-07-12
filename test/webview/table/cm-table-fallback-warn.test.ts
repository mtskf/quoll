// Pins the dev-visible warning tableBlockField emits when its bounded source —
// tableSkeletonField — is not registered and it falls back to the unbounded
// full walk+parse (the PERF.md bounding invariant is then not held). A single
// test drives the whole warn-once lifecycle: registered → silent, first
// fallback → one warning, second fallback → still one (latch holds). Kept in
// its own file so the module-scoped warn-once latch starts fresh (vitest
// isolates module state per test file).
//
// Cross-file note: other suites that mount tableBlockField WITHOUT the skeleton
// field (e.g. cm-table-field.test.ts, which exercises widget/reveal behaviour on
// the fallback path) also trip this warn once per process. That is intentional —
// the warn correctly flags an unregistered field — and harmless: the default
// vitest reporter swallows console output for passing tests and there is no
// fail-on-console gate. This dedicated file mocks console.warn to assert on it.
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { tableBlockField, tableSkeletonField } from "../../../src/webview/cm/table/index.js";

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

      // Field absent → fallback fires (create path) → exactly one dev-visible warning.
      const live = EditorState.create({ doc: TABLE, extensions: base });
      expect(fallbackWarnings(warn)).toBe(1);

      // Fallback again (create path) → the module-scoped latch holds; still exactly one.
      EditorState.create({ doc: TABLE, extensions: base });
      expect(fallbackWarnings(warn)).toBe(1);

      // Update path (defence-in-depth): dispatch doc-changing transactions on the
      // live no-skeleton instance. Each runs update → computeFresh → buildAll →
      // resolveModels, the same shared choke point the create path hits — so the
      // create-path assertions above already catch a per-call latch regression.
      // This pins that the update/per-keystroke branch re-enters that choke point
      // without re-warning, guarding a future refactor that split the update path
      // onto its own resolve/latch.
      let state = live;
      for (let i = 0; i < 3; i++) {
        state = state.update({ changes: { from: state.doc.length, insert: "\nx" } }).state;
      }
      expect(fallbackWarnings(warn)).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });
});
