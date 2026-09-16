// Structural lockstep guard for the EOL-insensitive content compare.
//
// The host and the webview ask the SAME question about the SAME document —
// "do these two strings carry the same text, ignoring line endings?" — and for
// a while they answered it with two hand-copied implementations, regex and all:
// `contentMatches` in src/extension/session/host-session-core.ts and a local
// `sameText` in src/webview/cm/edit-sync.ts. One-sided drift is user-visible in
// BOTH directions: widen the host's and the webview announces a discard on every
// epoch advance; widen the webview's and a real loss goes unannounced. That is
// the defect class docs/LEARNING.md (2026-09-15) names for this very module —
// "同じ Document について 2 つの判断をするなら述語は 1 本にして両方から読ませる".
//
// The copies were collapsed into src/shared/text-equality.ts. The BEHAVIOUR of
// that one function is pinned by test/shared/text-equality.test.ts and, on the
// host side, by the pair table test/extension/session/host-session-core.test.ts
// imports from test/shared/eol-pair-table.ts. Those prove the definition is
// right; nothing there notices if a future edit re-inlines a second copy next
// to it and quietly stops using the shared one. This file is that missing half:
// it pins the STRUCTURE — one definition, both sides importing it — so the
// copies cannot come back without a red.
//
// Why a build-level source contract and not a runtime assertion: the property is
// "there is only one implementation in the tree", which no amount of calling the
// function can observe. The trade-off is the usual one for source contracts —
// it reads bytes, so it is only as precise as its patterns, which is why the
// comment-strip below is load-bearing (docs/LEARNING.md: a rule-shaped literal
// inside a comment vacuated an earlier styles contract the same way).
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");

/** Strip block and line comments before matching. Prose about the regex —
 *  which both consumer files legitimately carry, since they explain WHY the
 *  compare is EOL-insensitive — must not read as a second implementation, and
 *  a re-inlined copy must not be able to hide inside a comment either. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/** The comparison idiom: normalise every EOL form to LF. Deliberately narrower
 *  than "any `.replace` touching \\r" — src/extension/session/document-canonical.ts
 *  and several CM helpers normalise EOLs for other purposes (canonicalising to a
 *  document separator, slicing a node), and folding those into this guard would
 *  make it fire on unrelated code. */
const EOL_FOLD = /\.replace\(\s*\/\\r\\n\|\\r\|\\n\/g\s*,\s*"\\n"\s*\)/g;

const SHARED = "../../src/shared/text-equality.ts";
const CONSUMERS = [
  ["webview", "../../src/webview/cm/edit-sync.ts"],
  ["host", "../../src/extension/session/host-session-core.ts"],
] as const;

describe("build: the EOL-insensitive compare has ONE definition", () => {
  it("lives in src/shared/text-equality.ts and is exported", () => {
    const shared = read(SHARED);
    expect(shared).toContain("export function sameTextIgnoringEol");
    // Two occurrences: one per operand of the single comparison.
    expect(stripComments(shared).match(EOL_FOLD) ?? []).toHaveLength(2);
  });

  for (const [side, path] of CONSUMERS) {
    it(`the ${side} side imports it instead of carrying a copy`, () => {
      const src = stripComments(read(path));
      expect(src).toMatch(
        /import\s*\{\s*sameTextIgnoringEol\s*\}\s*from\s*"\.\.\/\.\.\/shared\/text-equality\.js"/
      );
      // The point of the guard: no second implementation beside the import.
      // A THIRD copy would be the same defect, and lands in whichever of these
      // two files asks the question — the wider tree normalises EOLs for other
      // purposes, which is why the scope stays at these two (see EOL_FOLD).
      expect(src.match(EOL_FOLD) ?? []).toHaveLength(0);
    });
  }
});
