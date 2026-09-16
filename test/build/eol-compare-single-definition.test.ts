// Structural lockstep guard for the EOL-insensitive content compare.
//
// The host and the webview ask the SAME question about the SAME document —
// "do these two strings carry the same text, ignoring line endings?" — and for
// a while they answered it with two hand-copied implementations, regex and all:
// `contentMatches` in src/extension/session/host-session-core.ts and a local
// `sameText` in src/webview/cm/edit-sync.ts. One-sided drift is user-visible on
// either side, with per-side symptoms — the full argument lives on
// src/shared/text-equality.ts; do not restate it here. That is the defect class
// docs/LEARNING.md (2026-09-15) names for this very module —
// "同じ Document について 2 つの判断をするなら述語は 1 本にして両方から読ませる".
//
// The copies were collapsed into src/shared/text-equality.ts. The BEHAVIOUR of
// that one function is pinned by test/shared/text-equality.test.ts and, on the
// host side, by the pair table test/extension/session/host-session-core.test.ts
// imports from test/shared/eol-pair-table.ts. Those prove the definition is
// right; nothing there notices if a future edit re-inlines a second copy next
// to it and quietly stops using the shared one. This file is that missing half:
// it pins the STRUCTURE — one definition, both sides importing it, and imported
// is not enough: each consumer must also CALL it. A re-inlined copy reds two
// ways, so it cannot come back quietly: the exact idiom trips the EOL_FOLD
// count, and ANY other spelling (`/\r\n?|\n/`, a hoisted regex const,
// split/join) trips the `\r` ban, because neither consumer mentions `\r` at all.
//
// ⚠️ The `\r` ban is a CONSTRAINT on these two files, chosen deliberately: a
// `\r` mention in src/webview/cm/edit-sync.ts or
// src/extension/session/host-session-core.ts must live in a FULL-LINE comment,
// because the line-comment strip below is `^[ \t]*`-anchored and a trailing
// `// … \r …` would red the ban. Un-anchoring the strip was the alternative and
// is worse: `//` inside a string literal (a URL) would swallow the rest of that
// line, and a re-inlined fold sitting after it would pass the absence check
// vacuously. Fail-closed beats fail-open for a guard.
//
// Why a build-level source contract and not a runtime assertion: the property is
// "there is only one implementation in the tree", which no amount of calling the
// function can observe. The trade-off is the usual one for source contracts —
// it reads bytes, so it is only as precise as its patterns, which is why the
// comment-strip below is load-bearing (docs/LEARNING.md: a rule-shaped literal
// inside a comment vacuated an earlier styles contract the same way) and why the
// strip has its own inert-fixture pin rather than a comment claiming it matters.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");

/** Strip block comments and FULL-LINE `//` comments before matching. Prose about
 *  the regex — which both consumer files legitimately carry, since they explain
 *  WHY the compare is EOL-insensitive — must not read as a second
 *  implementation, and a re-inlined copy must not be able to hide inside a
 *  comment either.
 *  TWO known limits, in opposite directions. Fail-CLOSED: the line pass is
 *  `^[ \t]*`-anchored, so a comment trailing real code is never stripped — it
 *  can only make the guard fire, which is why the header turns it into a
 *  constraint rather than a hole. Fail-OPEN, the one that matters: blocks are
 *  stripped FIRST and unanchored, so a `/*` inside a line comment swallows text
 *  up to the next close, and a copy below that point passes the absence check
 *  vacuously. The inert fixture below is what keeps the strip observable
 *  instead of asserted. */
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
    // Both reads go through the strip, so the two assertions cannot disagree
    // about which bytes they are describing.
    const shared = stripComments(read(SHARED));
    expect(shared).toContain("export function sameTextIgnoringEol");
    // Two occurrences: one per operand of the single comparison.
    expect(shared.match(EOL_FOLD) ?? []).toHaveLength(2);
  });

  // Inert fixture: proves the strip is load-bearing instead of asserting it in a
  // comment. Before this test existed, reducing `stripComments` to the identity
  // left the whole suite green (measured) — the helper the header calls
  // load-bearing was itself unpinned, so a tidy-up could drop it as "defensive,
  // nothing fails" and silently re-open the comment-hiding hole.
  // Both halves of the guard are vacuable by a comment, so pin both, and in both
  // directions: the un-stripped fixture must be FOOLED, or a strip that silently
  // stopped running would still look pinned.
  it("the comment-strip is load-bearing (a commented copy must not satisfy either half)", () => {
    const disguised = [
      '// import { sameTextIgnoringEol } from "../../shared/text-equality.js";',
      '/* a.replace(/\\r\\n|\\r|\\n/g, "\\n") === b.replace(/\\r\\n|\\r|\\n/g, "\\n") */',
    ].join("\n");
    // Un-stripped, both halves are fooled by the comments.
    expect(disguised).toMatch(/import\s*\{\s*sameTextIgnoringEol\s*\}/);
    expect(disguised.match(EOL_FOLD) ?? []).toHaveLength(2);
    // Stripped, neither is.
    expect(stripComments(disguised)).not.toMatch(/import\s*\{\s*sameTextIgnoringEol\s*\}/);
    expect(stripComments(disguised).match(EOL_FOLD) ?? []).toHaveLength(0);
  });

  for (const [side, path] of CONSUMERS) {
    it(`the ${side} side imports it instead of carrying a copy`, () => {
      const src = stripComments(read(path));
      expect(src).toMatch(
        /import\s*\{\s*sameTextIgnoringEol\s*\}\s*from\s*"\.\.\/\.\.\/shared\/text-equality\.js"/
      );
      // Imported AND called — an unused import beside a local copy is the defect,
      // and the import assertion alone cannot see it.
      expect(src.match(/\bsameTextIgnoringEol\(/g) ?? []).not.toHaveLength(0);
      // The point of the guard: no second implementation beside the import.
      // A THIRD copy would be the same defect, and lands in whichever of these
      // two files asks the question — the wider tree normalises EOLs for other
      // purposes, which is why the scope stays at these two (see EOL_FOLD).
      expect(src.match(EOL_FOLD) ?? []).toHaveLength(0);
      // No EOL handling of ANY spelling. EOL_FOLD is deliberately one idiom, so
      // on its own it is evadable: measured at dccbb48, `/\r\n?|\n/g` (the
      // spelling src/webview/cm/seed.ts itself uses), a hoisted regex const and
      // split/join all pass it while keeping the import. Neither consumer touches
      // `\r` at all (measured: 0 occurrences in both, comments included), so any
      // re-inlined fold reads as a copy whatever its spelling. Full-line comments
      // only — see the header.
      expect(src).not.toMatch(/\\r/);
    });
  }
});
