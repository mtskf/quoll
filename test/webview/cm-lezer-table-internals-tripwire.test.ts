// @vitest-environment node
//
// The TABLE-DELIM arm mirrors @lezer/markdown's PRIVATE table internals, and
// package.json declares `@lezer/markdown: "^1.8.1"` — a CARET range. A doc comment naming
// a version cannot stop a `pnpm update` from changing the thing being mirrored, so this
// test asserts the mirrored facts against the INSTALLED dist and reds on drift. It is
// deliberately a source-text assertion: the internals are not exported, so there is no
// API to interrogate.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { isTableDelimiterShaped } from "../../src/webview/cm/structural-guard.js";

const require_ = createRequire(import.meta.url);
const distPath = require_.resolve("@lezer/markdown");
const dist = readFileSync(distPath, "utf8");

describe("@lezer/markdown table internals the guard mirrors", () => {
  // patches/@lezer__markdown@1.8.1.patch respells upstream's delimiterLine (whose
  // overlapping `[>\s]*` / `\s*` quantifiers backtrack quadratically on a long
  // indent) in both builds, the same way as the mirror in structural-guard.ts.
  it("ships the patched delimiterLine in both builds", () => {
    const esm = readFileSync(join(dirname(distPath), "index.js"), "utf8");
    const patched =
      "const delimiterLine = /^[>\\s]*(?:\\|\\s*)?:?-+:?\\s*\\|(?:\\s*:?-+:?\\s*\\|)*(?:\\s*:?-+:?\\s*)?$/;";
    expect(dist).toContain(patched);
    expect(esm).toContain(patched);
  });

  // The oracle is upstream's ORIGINAL 1.8.1 spelling, as a literal: the dist now
  // carries the respelling, so reading it from there would compare it with itself.
  it("answers like upstream's original delimiterLine regex on every short line", () => {
    const upstream = /^[>\s]*\|?(\s*:?-+:?\s*\|)+(\s*:?-+:?\s*)?$/;
    const alphabet = [" ", "\t", ">", "|", ":", "-", "x", "\u00a0"];
    let lines = [""];
    let checked = 0;
    let delimiters = 0;
    const mismatches: string[] = [];
    for (let len = 0; len <= 5; len++) {
      for (const line of lines) {
        for (const prefix of ["", "   ", "> ", "\t> > "]) {
          const text = prefix + line;
          const want = upstream.test(text);
          if (isTableDelimiterShaped(text) !== want) {
            mismatches.push(text);
          }
          checked++;
          delimiters += want ? 1 : 0;
        }
      }
      lines = lines.flatMap((l) => alphabet.map((c) => l + c));
    }
    expect(mismatches).toEqual([]);
    expect(checked).toBeGreaterThan(100_000);
    expect(delimiters).toBeGreaterThan(1_000);
  });

  it("rejects a long indented non-delimiter line in linear time", () => {
    // The upstream spelling takes seconds here (quadratic backtracking on the indent).
    const text = `${" ".repeat(50_000)}plain prose`;
    const start = performance.now();
    expect(isTableDelimiterShaped(text)).toBe(false);
    expect(isTableDelimiterShaped(`${" ".repeat(50_000)}|---|`)).toBe(true);
    expect(performance.now() - start).toBeLessThan(200);
  });

  it("still applies that regex to the RAW peeked line in endLeaf", () => {
    // endLeaf tests `cx.peekLine()` raw while TableParser.nextLine tests
    // `line.text.slice(line.pos)`. `isTableDelimiterShaped` reads the raw line ONCE because the
    // 1.8.1 regex's `[>\s]*` head absorbs the leading whitespace both call sites differ by.
    // The patched-regex test pins its text: if it goes red, re-derive how each site reads the line.
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
    // The mirrors were re-derived from 1.8.1 (first derived from 1.6.4). A bump is not forbidden, but it must be a
    // CONSCIOUS edit here — the four assertions above are what actually check the
    // behaviour, and this line is what makes an unnoticed bump visible in the diff.
    expect(manifest.version).toBe("1.8.1");
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

  it("imports only the frontier term and the table-shape arm, never the shared structural guard", () => {
    // The fenced field composes the shared frontier predicate (`frontierIncomplete`) with
    // its OWN structural predicate (`fencedCollapseSpec.docChangePlan`), so its import from
    // the shared guard must name only `frontierIncomplete` and the table-shape arm: importing
    // `touchesStructuralReparse` or `requiresFullBoundedRebuild` would put its in-fence hot
    // path behind the wider shared STRUCTURAL.
    // ⚠️ Assert the IMPORT FORM, not the bare path: the file also carries the literal
    // `../structural-guard.js` inside a COMMENT, so a bare-path match reads a comment. That
    // is the mirror image of the vacuous-grep trap in docs/LEARNING.md (a comment literal
    // satisfying a source contract).
    const imports = [
      ...fencedSrc.matchAll(
        /import\s*(?:type\s*)?\{([^}]*)\}\s*from "\.\.\/structural-guard\.js"/g
      ),
    ].map((m) => m[1].trim());
    // `tableRowShapeChanged` is allowed: the field applies it only to TOP-LEVEL edits
    // (`topLevelBoundaryRisk`), so in-fence typing stays bounded.
    expect(imports).toEqual(["frontierIncomplete, tableRowShapeChanged"]);
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
