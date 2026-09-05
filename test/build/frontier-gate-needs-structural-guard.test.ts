// Choke point: `syntaxTreeAvailable(<expr>.state, …)` — the transaction-reducer spelling
// of the parse-frontier check a changed-range-bounded StateField consults before reusing
// its records — may appear in exactly ONE place: the definition of
// `requiresFullBoundedRebuild` in structural-guard.ts.
//
// WHY: two bounded fields (imageBlockField, tableSkeletonField) shipped with only this
// frontier half of the admission test and no structural-reparse half, because the OR was
// hand-spelled per field instead of named once. `requiresFullBoundedRebuild` (structural-
// guard.ts) is the fix — a single function that pairs both terms so a caller cannot invoke
// one without the other. This guard is what stops a NEW hand-spelled copy (or one that
// gets a term wrong) from reappearing: if a new bounded field writes
// `!syntaxTreeAvailable(tr.state, tr.state.doc.length)` directly instead of importing the
// helper, this test names the offending file.
//
// An earlier draft of this guard asked "does this FILE also mention something called
// `touchesStructural*`?" — a file-level co-occurrence heuristic. Three independent design
// reviews rejected it: a second bounded reducer added to an already-compliant file would
// satisfy a file-level condition without ever consulting the guard. Naming the admission
// test (`requiresFullBoundedRebuild`) removes the need for that heuristic — the rule below
// is decidable from the call site alone, with no inference about what else the file
// contains.
//
// WHY AN AST WALK AND NOT A REGEX: a line-oriented regex is defeated by an ordinary Biome
// reflow — when a call wraps across lines the scan silently stops seeing it, so a
// formatter acting in good faith disables the pin. A regex also cannot tell source from a
// string/comment literal without a comment-stripper whose own flaws are documented in
// test/markdown/url-choke-point.test.ts. Asking TypeScript removes both problems; this repo
// already reached for the same answer for the same class of bug in
// no-bare-unstarved-gate.test.ts and no-file-level-ts-nocheck.test.ts.
//
// SCOPE — this walks `src/webview/cm/**/*.ts` and counts exactly one CALL SHAPE: a
// `CallExpression` whose callee is the bare identifier `syntaxTreeAvailable` and whose
// FIRST argument is a property-access expression named `state` (the `tr.state` /
// `view.state` reducer spelling). A first argument that is a plain identifier —
// `syntaxTreeAvailable(state, …)` inside `fold/index.ts`'s `reconcileReseedFolds`, a
// helper QUERY rather than a bounded-field reducer — is deliberately NOT counted; that is
// what lets `fold/index.ts` hold a plain call while still being required to route its
// reducer-shaped check through the named helper.
//
// THE ALLOWLIST PINS AN EXACT COUNT PER FILE, not merely the file name. A file-level
// allowance would let a NEW bare gate be added to an already-allowlisted file unnoticed —
// exactly the discipline no-bare-unstarved-gate.test.ts already argues for.
//
// ALLOWLIST:
//   - structural-guard.ts (1) — the definition of `requiresFullBoundedRebuild` itself.
//   - fenced-code/fenced-code-collapse.ts (1) — documented, deliberate exception. Its
//     frontier check is `mode === "full" || !syntaxTreeAvailable(…)`, a DIFFERENT
//     disjunction whose other term is the test-oracle switch, not the structural guard; its
//     actual structural check (`touchesStructural` + `topLevelBoundaryRisk`) sits on an
//     earlier arm. It is not migrated to `requiresFullBoundedRebuild` — see the comment at
//     its own call site and fenced-code-collapse.ts's header.
//   - every other file — 0.
//
// Two further assertions close the gap a call-count alone cannot: (a) `structural-guard.ts`
// must EXPORT a function declaration named `requiresFullBoundedRebuild` — without this, a
// rename at the definition alone would leave every call site spelling the old name, and the
// call-count assertion (b) would stay green while only `pnpm compile` reds, which is not
// this guard doing its job; (b) the helper must be CALLED at least once outside its own
// file — without this, deleting every call site (a silent regression back to hand-spelled
// checks) would go unnoticed since the call-count assertion never inspects call sites of
// the helper itself, only of `syntaxTreeAvailable`.
//
// KNOWN GAPS — the match is SYNTACTIC, so each of these slips past it:
//   - an import alias, or a re-exported wrapper around `syntaxTreeAvailable`, defeats the
//     bare-identifier match.
//   - a first argument reached through a local variable (`const st = tr.state;
//     syntaxTreeAvailable(st, …)`) is not the property-access shape and is not counted —
//     it would neither be flagged as a violation NOR correctly recognised as the reducer
//     spelling it actually is.
//   - this guard says nothing about whether a consumer calls `requiresFullBoundedRebuild`
//     on the RIGHT arm of its reducer, or at all — it only removes the hand-spelled gate as
//     a way to get that pairing wrong. A field that never calls it at all (and so never
//     full-rebuilds on a structural reparse) is invisible here.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const CM_ROOT = fileURLToPath(new URL("../../src/webview/cm", import.meta.url));

/** file (relative to src/webview/cm) → how many reducer-shaped gates it may carry. The
 *  ALLOWLIST block in this file's header owns the reasons; kept there rather than as a
 *  field here so there is one place to read them and none to leave stale. */
const ALLOW = new Map<string, number>([
  // the definition of requiresFullBoundedRebuild itself
  ["structural-guard.ts", 1],
  // documented exception — its other disjunct is the test-oracle mode switch, and its
  // structural check is a narrower predicate on an earlier arm
  ["fenced-code/fenced-code-collapse.ts", 1],
]);

/** 1-based line numbers of every node in `text` that `match` accepts. The one AST walk
 *  the three shape queries below share — each differs only in its `match`, so writing the
 *  traversal once is what keeps them from drifting apart. */
function matchingNodeLines(
  text: string,
  fileName: string,
  match: (node: ts.Node) => boolean
): number[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const hits: number[] = [];
  const visit = (node: ts.Node): void => {
    if (match(node)) {
      hits.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

function isReducerShapedCall(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "syntaxTreeAvailable" &&
    node.arguments.length >= 1 &&
    ts.isPropertyAccessExpression(node.arguments[0]) &&
    node.arguments[0].name.text === "state"
  );
}

/** 1-based line numbers of every reducer-shaped `syntaxTreeAvailable(<expr>.state, …)`
 *  call in `text`. Not exported: this file's own tests below are its only consumer. */
function findReducerShapedGates(text: string, fileName: string): number[] {
  return matchingNodeLines(text, fileName, isReducerShapedCall);
}

/** True if `text` calls `requiresFullBoundedRebuild` at least once, as a bare
 *  identifier call (`requiresFullBoundedRebuild(tr)`), not merely mentions the name in a
 *  comment or string. */
function callsRequiresFullBoundedRebuild(text: string, fileName: string): boolean {
  return (
    matchingNodeLines(
      text,
      fileName,
      (node) =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "requiresFullBoundedRebuild"
    ).length > 0
  );
}

/** True if `text` contains an EXPORTED function declaration named `name` — either
 *  `export function name(...)` or `export`+later `function name(...)` combined via a
 *  modifier check on the declaration itself (this codebase only uses the inline form, so
 *  only that shape is checked). */
function exportsFunctionDeclaration(text: string, fileName: string, name: string): boolean {
  return (
    matchingNodeLines(
      text,
      fileName,
      (node) =>
        ts.isFunctionDeclaration(node) &&
        node.name?.text === name &&
        (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0
    ).length > 0
  );
}

function scannableFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      scannableFiles(abs, out);
    } else if (/\.ts$/.test(entry)) {
      out.push(abs);
    }
  }
  return out;
}

/** `src/webview/cm`-relative path in POSIX form. */
function cmRelative(abs: string): string {
  return relative(CM_ROOT, abs).split("\\").join("/");
}

/** file (relative to src/webview/cm) → the lines carrying a reducer-shaped call. */
function census(): Map<string, number[]> {
  const found = new Map<string, number[]>();
  for (const abs of scannableFiles(CM_ROOT)) {
    const rel = cmRelative(abs);
    const lines = findReducerShapedGates(readFileSync(abs, "utf8"), abs);
    if (lines.length > 0) {
      found.set(rel, lines);
    }
  }
  return found;
}

/** Census + allowlist → the violation lines, in both directions (a file over its
 *  allowance, or a file with no allowance at all). Split out so the comparison itself is
 *  reachable by a synthetic fixture, which is what makes "no violations" distinguishable
 *  from "the comparison never flags anything". */
function violationsIn(found: Map<string, number[]>, allow: typeof ALLOW): string[] {
  const violations: string[] = [];
  for (const [rel, lines] of found) {
    const allowed = allow.get(rel) ?? 0;
    if (lines.length !== allowed) {
      violations.push(
        `${rel}: ${lines.length} reducer-shaped gate(s) at line(s) ${lines.join(", ")}, allowed ${allowed}`
      );
    }
  }
  for (const [rel, count] of allow) {
    if (!found.has(rel) && count > 0) {
      violations.push(`${rel}: 0 reducer-shaped gate(s) found, allowlist expects ${count}`);
    }
  }
  return violations;
}

describe("the scanner itself is not vacuous", () => {
  it("flags the reducer shape, including when a formatter has split it", () => {
    expect(
      findReducerShapedGates("syntaxTreeAvailable(tr.state, tr.state.doc.length);", "x.ts")
    ).toEqual([1]);
    // The case a line-oriented regex misses.
    expect(
      findReducerShapedGates(
        "\nsyntaxTreeAvailable(\n  tr.state,\n  tr.state.doc.length\n);",
        "x.ts"
      )
    ).toEqual([2]);
  });

  it("does not flag the plain-identifier query shape or a string/comment mention", () => {
    expect(findReducerShapedGates("syntaxTreeAvailable(state, state.doc.length);", "x.ts")).toEqual(
      []
    );
    expect(findReducerShapedGates('const t = "syntaxTreeAvailable(tr.state, n)";', "x.ts")).toEqual(
      []
    );
    expect(findReducerShapedGates("// syntaxTreeAvailable(tr.state, n);", "x.ts")).toEqual([]);
    // A first argument reached through neither an identifier nor `.state` (e.g. a call
    // expression) is not the reducer shape either.
    expect(findReducerShapedGates("syntaxTreeAvailable(getState(), n);", "x.ts")).toEqual([]);
  });

  it("finds the exported function declaration shape, and rejects an un-exported or differently-named one", () => {
    expect(
      exportsFunctionDeclaration(
        "export function requiresFullBoundedRebuild(tr) { return true; }",
        "x.ts",
        "requiresFullBoundedRebuild"
      )
    ).toBe(true);
    expect(
      exportsFunctionDeclaration(
        "function requiresFullBoundedRebuild(tr) { return true; }",
        "x.ts",
        "requiresFullBoundedRebuild"
      )
    ).toBe(false);
    expect(
      exportsFunctionDeclaration(
        "export function otherName(tr) { return true; }",
        "x.ts",
        "requiresFullBoundedRebuild"
      )
    ).toBe(false);
  });

  it("finds a call to requiresFullBoundedRebuild, and ignores a comment mention", () => {
    expect(
      callsRequiresFullBoundedRebuild("if (requiresFullBoundedRebuild(tr)) { go(); }", "x.ts")
    ).toBe(true);
    expect(
      callsRequiresFullBoundedRebuild("// requiresFullBoundedRebuild(tr) is called here", "x.ts")
    ).toBe(false);
  });

  it("compares census against allowance in both directions", () => {
    const atCount = new Map([["allowed/at-its-count.ts", 2]]);
    const oneAllowed = new Map([["allowed/one-too-many.ts", 1]]);

    // Exactly at its allowance → not a violation.
    expect(violationsIn(new Map([["allowed/at-its-count.ts", [10, 20]]]), atCount)).toEqual([]);
    // Not in the allowlist at all → any gate is a violation.
    expect(violationsIn(new Map([["unlisted.ts", [7]]]), new Map())).toEqual([
      "unlisted.ts: 1 reducer-shaped gate(s) at line(s) 7, allowed 0",
    ]);
    // Over its allowance → a violation naming the actual vs. allowed count.
    expect(violationsIn(new Map([["allowed/one-too-many.ts", [3, 9]]]), oneAllowed)).toEqual([
      "allowed/one-too-many.ts: 2 reducer-shaped gate(s) at line(s) 3, 9, allowed 1",
    ]);
    // An allowlisted file that no longer carries ANY reducer-shaped call (e.g. its
    // exemption was earned by a call that has since been migrated away) must also flag —
    // a stale allowance is exactly what would let a future deletion of the ONLY
    // legitimate gate go unnoticed.
    expect(violationsIn(new Map(), oneAllowed)).toEqual([
      "allowed/one-too-many.ts: 0 reducer-shaped gate(s) found, allowlist expects 1",
    ]);
  });

  it("scans every subtree under src/webview/cm, not just the allowlisted files", () => {
    const scanned = new Set(scannableFiles(CM_ROOT).map(cmRelative));
    const dirs = new Set([...scanned].map((rel) => rel.split("/").slice(0, -1).join("/")));
    for (const required of [
      "fold",
      "image",
      "table",
      "fenced-code",
      "decorations",
      "frontmatter",
    ]) {
      expect(dirs, `the walk no longer reaches src/webview/cm/${required}`).toContain(required);
    }
    expect(scanned).toContain("structural-guard.ts");
  });
});

describe("the frontier gate has exactly one reducer-shaped spelling", () => {
  it("flags no file outside the allowlist, and no extra gate inside one", () => {
    expect(violationsIn(census(), ALLOW)).toEqual([]);
  });

  it("keeps the allowlist live — every entry still carries exactly the count it excuses", () => {
    const found = census();
    for (const [rel, count] of ALLOW) {
      expect(found.get(rel)?.length ?? 0, `${rel} allowlist count is stale`).toBe(count);
    }
  });

  it("structural-guard.ts exports a function declaration named requiresFullBoundedRebuild", () => {
    const path = join(CM_ROOT, "structural-guard.ts");
    expect(
      exportsFunctionDeclaration(readFileSync(path, "utf8"), path, "requiresFullBoundedRebuild")
    ).toBe(true);
  });

  it("requiresFullBoundedRebuild is called at least once outside structural-guard.ts", () => {
    const called = scannableFiles(CM_ROOT)
      .filter((abs) => cmRelative(abs) !== "structural-guard.ts")
      .some((abs) => callsRequiresFullBoundedRebuild(readFileSync(abs, "utf8"), abs));
    expect(called).toBe(true);
  });
});
