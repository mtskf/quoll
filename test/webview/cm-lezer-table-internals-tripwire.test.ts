// @vitest-environment node
//
// The TABLE-DELIM arm mirrors @lezer/markdown's PRIVATE table internals, and
// package.json declares `@lezer/markdown: "^1.6.4"` — a CARET range. A doc comment naming
// a version cannot stop a `pnpm update` from changing the thing being mirrored, so this
// test asserts the mirrored facts against the INSTALLED dist and reds on drift. It is
// deliberately a source-text assertion: the internals are not exported, so there is no
// API to interrogate.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const distPath = require_.resolve("@lezer/markdown");
const dist = readFileSync(distPath, "utf8");

describe("@lezer/markdown table internals the guard mirrors", () => {
  it("still ships the delimiterLine regex the mirror copies verbatim", () => {
    expect(dist).toContain("const delimiterLine = /^\\|?(\\s*:?-+:?\\s*\\|)+(\\s*:?-+:?\\s*)?$/;");
  });

  it("still applies that regex to the RAW peeked line in endLeaf", () => {
    // This asymmetry — endLeaf tests `cx.peekLine()` raw while TableParser.nextLine tests
    // `line.text.slice(line.pos)` — is why `isTableDelimiterShaped` reads the line BOTH ways
    // before deciding it is delimiter-shaped. ⚠️ Against the 1.6.4 regex above the raw read
    // is currently SUBSUMED by the stripped one (proof in that function's doc comment), so
    // deleting it reds nothing — which is exactly why THIS test, pinning the regex verbatim,
    // is the notice to re-derive both reads rather than to drop one.
    expect(dist).toMatch(/let next = cx\.peekLine\(\);\s*\n\s*return delimiterLine\.test\(next\)/);
    expect(dist).toContain("delimiterLine.test(lineText = line.text.slice(line.pos))");
  });

  it("still counts cells with the parseRow loop the mirror reproduces", () => {
    expect(dist).toContain("if (!first || cellStart > -1)");
    expect(dist).toContain("esc = !esc && next == 92");
  });

  it("still starts hasPipe / parseRow at the container-content offset", () => {
    // The mirrors read the WHOLE raw line while the parser starts at `line.pos` /
    // `line.basePos` / `leaf.content`. Three cases, not one:
    //   1. WHITESPACE prefix — equivalent, because it holds no pipe and never opens a cell.
    //   2. CONTAINER-MARKER prefix (`> | b`) — NOT equivalent: 1 cell to the parser, 2 to
    //      the mirror. Carried by SHAPE's container alternation firing on such a line
    //      first, a CROSS-ARM dependency spelled out in structural-guard.ts's TABLE-DELIM
    //      header ("Narrowing SHAPE's container alternation would make these mirrors
    //      unsound without touching them").
    //   3. The FOURTH assertion below — `endLeaf` measures the PEEKED line with the
    //      PRECEDING line's `basePos`, so a delimiter line LESS indented than its header is
    //      measured from an offset that is neither whitespace nor a container marker. No
    //      per-line mirror can reproduce that, which is why the guard retreats to PRESENCE
    //      on a delimiter-shaped line instead of comparing it.
    // Pin the call sites so a future upstream change to those offsets is a red, not a
    // silent divergence (Codex rev.2, Confidence 87).
    expect(dist).toContain("hasPipe(leaf.content, 0)");
    expect(dist).toContain("hasPipe(line.text, line.basePos)");
    expect(dist).toContain("parseRow(cx, line.text, line.pos, content, cx.lineStart)");
    expect(dist).toContain(
      "parseRow(cx, line.text, line.basePos) == parseRow(cx, next, line.basePos)"
    );
  });

  it("resolves to the version the mirrors were derived from", () => {
    // ⚠️ `require("@lezer/markdown/package.json")` throws ERR_PACKAGE_PATH_NOT_EXPORTED —
    // the package's `exports` map does not expose it (measured, 2026-09-05). Read it off
    // the resolved dist path instead. `require_.resolve` returns dist/index.cjs, so the
    // manifest is two levels up.
    const manifest = JSON.parse(
      readFileSync(join(dirname(distPath), "..", "package.json"), "utf8")
    ) as { version: string };
    // The mirrors were derived from 1.6.4. A bump is not forbidden, but it must be a
    // CONSCIOUS edit here — the four assertions above are what actually check the
    // behaviour, and this line is what makes an unnoticed bump visible in the diff.
    expect(manifest.version).toBe("1.6.4");
  });
});

describe("the fenced-code field keeps its own narrower guard", () => {
  const guardSrc = readFileSync(
    new URL("../../src/webview/cm/structural-guard.ts", import.meta.url),
    "utf8"
  );
  const fencedSrc = readFileSync(
    new URL("../../src/webview/cm/fenced-code/fenced-code-collapse.ts", import.meta.url),
    "utf8"
  );

  it("does not import the shared guard", () => {
    // ⚠️ Assert the IMPORT FORM, not the bare path. `fenced-code-collapse.ts:434` already
    // contains the literal `../structural-guard.js` inside a COMMENT ("the fields that
    // import ../structural-guard.js"), so `not.toContain("structural-guard.js")` reds on a
    // correct file. That is the mirror image of the vacuous-grep trap in docs/LEARNING.md
    // (a comment literal satisfying a source contract) — here a comment literal VIOLATES
    // one. Verified against the shipped file, 2026-09-05.
    expect(fencedSrc).not.toMatch(/from "\.\.\/structural-guard\.js"/);
  });

  it("keeps an ATX / Setext / underscore-free regex, unlike the shared one", () => {
    // The shared guard gained an ATX, an underscore and a Setext alternation and relaxed its
    // indent bound; the fenced one must have none of that, or its in-fence hot path is gone.
    const fencedRe = /const STRUCTURAL =\s*\n\s*(\/.*\/i);/.exec(fencedSrc)?.[1] ?? "";
    const sharedRe = /const STRUCTURAL =\s*\n\s*(\/.*\/i);/.exec(guardSrc)?.[1] ?? "";
    expect(fencedRe).not.toBe("");
    expect(sharedRe).not.toBe("");
    expect(fencedRe).not.toBe(sharedRe);
    expect(fencedRe).not.toContain("#{1,6}");
    expect(fencedRe).not.toContain("=+");
    expect(fencedRe).not.toContain("_[ \\t]*");
    expect(sharedRe).toContain("#{1,6}");
    expect(sharedRe).toContain("=+");
    expect(sharedRe).toContain("_[ \\t]*");
  });
});
