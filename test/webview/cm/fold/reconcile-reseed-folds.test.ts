import {
  codeFolding,
  ensureSyntaxTree,
  foldable,
  foldEffect,
  foldedRanges,
  syntaxTreeAvailable,
} from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { reconcileReseedFolds } from "../../../../src/webview/cm/fold/index.js";
import { quollMarkdownLanguage } from "../../../../src/webview/cm/markdown.js";

// A large trailing body so CM's bounded initial parse (leading region only)
// leaves the frontier incomplete: syntaxTreeAvailable(doc.length) === false,
// deterministically, while the leading "# One"/"# New" region IS parsed. Mirrors
// the partial-tree fixtures in cm-decoration-viewport.test.ts.
const BIG_TAIL = `\n\n${"filler paragraph body text.\n\n".repeat(4000)}`;

function foldRanges(state: EditorState): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  foldedRanges(state).between(0, state.doc.length, (from, to) => {
    out.push({ from, to });
  });
  return out;
}

describe("reconcileReseedFolds — incomplete post-reseed parse frontier", () => {
  it("bails on an incomplete parse, then clamps the over-wide fold once the tree is complete", () => {
    // "# One"'s body now contains a same-level sibling "# New" (as a reseed would
    // have inserted). The over-wide fold spans from end-of-"# One" through past
    // "# New", swallowing it — the exact stale-fold shape PR #293 clamps.
    const head = "# One\n\nalpha\n\n# New\n\ngamma\n\n# Two\n\ncharlie";
    const doc = head + BIG_TAIL;
    let state = EditorState.create({
      doc,
      extensions: [quollMarkdownLanguage(), codeFolding()],
    });

    const line1 = state.doc.line(1); // "# One"
    const overWideFrom = line1.to; // end of the "# One" line
    const overWideTo = doc.indexOf("# Two"); // swallows "# New"
    state = state.update({ effects: foldEffect.of({ from: overWideFrom, to: overWideTo }) }).state;
    expect(foldRanges(state).length).toBe(1);

    // (1) Incomplete frontier → reconcile is a safe no-op (the bug: the stale
    // over-wide fold is left concealing "# New"). This is the deterministic,
    // non-vacuous pin for the incomplete-parse path — no forced parse beforehand.
    expect(syntaxTreeAvailable(state, state.doc.length)).toBe(false);
    const newPos = doc.indexOf("# New");
    const editedRange = { from: newPos, to: newPos + "# New".length };
    expect(reconcileReseedFolds(state, editedRange)).toEqual([]);
    expect(foldRanges(state)[0].to).toBeGreaterThan(newPos); // still conceals "# New"

    // (2) Once the parse is complete, reconcile clamps the over-wide fold back to
    // "# One"'s real section end. We complete the parse the way a test can produce a
    // complete-tree state (ensureSyntaxTree advances the context; the empty update
    // republishes it so syntaxTree(state) — which foldable() reads — reflects it).
    // We assert only the OUTCOME (availability + clamp), NOT CM's private tree-
    // snapshot mechanism (Codex review: don't pin an implementation detail).
    ensureSyntaxTree(state, state.doc.length, 5_000);
    state = state.update({}).state;
    expect(syntaxTreeAvailable(state, state.doc.length)).toBe(true);

    const effects = reconcileReseedFolds(state, editedRange);
    expect(effects.length).toBe(2); // unfold(stale) + fold(fresh)
    const clamped = state.update({ effects }).state;
    const [range] = foldRanges(clamped);
    expect(range.to).toBeLessThanOrEqual(newPos); // "# New" no longer concealed
    const freshLine1 = clamped.doc.line(1);
    expect(foldable(clamped, freshLine1.from, freshLine1.to)).toEqual(range);
  });

  it("leaves an over-wide fold untouched when the excess conceals no heading boundary", () => {
    const doc = "# One\n\nalpha\n\nbravo\n\ncharlie\n\n# Two\n\ndelta";
    let state = EditorState.create({
      doc,
      extensions: [quollMarkdownLanguage(), codeFolding()],
    });
    const line1 = state.doc.line(1);
    const canonical = foldable(state, line1.from, line1.to);
    if (!canonical) {
      throw new Error("heading line should be foldable");
    }
    const overWide = { from: canonical.from, to: canonical.to + 2 };
    state = state.update({ effects: foldEffect.of(overWide) }).state;

    expect(reconcileReseedFolds(state, { from: 0, to: 0 })).toEqual([]);
  });
});
