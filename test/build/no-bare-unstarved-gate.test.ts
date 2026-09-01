// Structural guard: no BARE `expect(syntaxTreeAvailable(...)).toBe(true)` in test/**.
//
// WHY: that assertion is the anti-masking gate several bounded-path tests use to confirm
// the post-edit parse frontier is COMPLETE, so the field's bounded branch — not its
// starved-frontier full-walk self-heal — is what they are measuring. Asserted on a SINGLE
// attempt it is load-fragile: CodeMirror gives the post-edit reparse a 20ms WALL-CLOCK
// budget, and under CPU starvation that window elapses while the process is descheduled,
// so the gate reds on a fact about the machine. PR #388 measured that (24 spinners on 8
// cores) and answered it with an attempt loop; three more sites carrying the bare shape
// were found afterwards and became a TODO entry. This guard is what stops a fourth from
// appearing: the load-robust shape is `withUnstarvedFrontier()` in
// test/webview/helpers/unstarved-frontier.ts.
//
// WHY AN AST WALK AND NOT A REGEX: a line-oriented regex is defeated by an ordinary Biome
// reflow — when the `expect(...)` call wraps across lines the scan silently stops seeing
// it, so a formatter acting in good faith disables the pin. A regex also cannot tell
// source from string literals without a comment-stripper whose own flaws are documented in
// test/markdown/url-choke-point.test.ts. Asking TypeScript removes both problems, and is
// the answer this repo already reached for the same class of bug: a hand-rolled @ts-nocheck
// scanner shipped four consecutive silent gaps before being replaced by a tsc query.
//
// SCOPE — this forbids exactly ONE shape:
//   - `.toBe(false)` gates are NOT flagged. They assert an INCOMPLETE frontier, and
//     starvation only makes a frontier less complete, so they cannot flake this way.
//   - The CONDITIONAL form, `if (syntaxTreeAvailable(...))`, is NOT flagged: it already
//     tolerates a starved frontier by construction.
//   - A `.toBe(true)` after an EXPLICITLY FORCED parse is legitimate and allowlisted below.
//
// THE ALLOWLIST PINS AN EXACT COUNT PER FILE, not merely the file. A file-level allowance
// would let a NEW bare gate be added to an already-allowlisted file without this guard
// noticing — which would defeat its whole purpose. Changing a count is a deliberate edit
// that must argue, in the same reviewed commit, why an in-budget parse is acceptable there.
//
// KNOWN GAPS — the match is SYNTACTIC, so each of these slips past it:
//   - a variable indirection: `const ok = syntaxTreeAvailable(...); expect(ok).toBe(true);`
//   - an import alias, or a re-exported wrapper around `syntaxTreeAvailable`
//   - a different matcher: `.toBeTruthy()`, `.toEqual(true)`
// Closing these would need type resolution rather than a syntax walk, which is more
// machinery than this rule is worth; `url-choke-point.test.ts` accepts the same limit.
// This is why the plan keeps a human read of the tree alongside this mechanised check.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const TEST_ROOT = fileURLToPath(new URL("..", import.meta.url));

const ALLOW = new Map<string, { count: number; reason: string }>([
  [
    "webview/cm/fold/reconcile-reseed-folds.test.ts",
    {
      count: 2,
      reason:
        "asserted after an EXPLICIT forceParsing/ensureSyntaxTree to a caller-supplied budget, not after the 20ms post-edit reparse",
    },
  ],
  [
    "webview/editor.test.ts",
    {
      count: 1,
      reason:
        "asserted after applyDocument's call-site forceParsing (RECONCILE_PARSE_BUDGET_MS = 500ms) — 25x the post-edit budget. Not an unconditional guarantee: if it ever flakes under load that is its own entry, not a reason to widen this guard",
    },
  ],
]);

/** 1-based line numbers of every `expect(syntaxTreeAvailable(...)).toBe(true)` in `text`. */
// Not exported: the scanner's own tests below are its only consumers, and vitest's
// noExportsInTest rule (rightly) treats an export from a test file as a smell.
function findBareGates(text: string, fileName: string): number[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const hits: number[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "toBe" &&
      node.arguments.length === 1 &&
      node.arguments[0].kind === ts.SyntaxKind.TrueKeyword
    ) {
      const receiver = node.expression.expression;
      // Vitest's `expect` takes an OPTIONAL second argument (a failure message), so a
      // strict arity of 1 would let `expect(syntaxTreeAvailable(x), "why").toBe(true)`
      // through — the same bare gate wearing a label. Only the first argument is the
      // asserted value.
      if (
        ts.isCallExpression(receiver) &&
        ts.isIdentifier(receiver.expression) &&
        receiver.expression.text === "expect" &&
        receiver.arguments.length >= 1 &&
        receiver.arguments.length <= 2
      ) {
        const asserted = receiver.arguments[0];
        if (
          ts.isCallExpression(asserted) &&
          ts.isIdentifier(asserted.expression) &&
          asserted.expression.text === "syntaxTreeAvailable"
        ) {
          hits.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

function scannableFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      if (entry !== "node_modules") {
        scannableFiles(abs, out);
      }
    } else if (/\.(?:ts|tsx|mts|cts)$/.test(entry)) {
      out.push(abs);
    }
  }
  return out;
}

/** file (relative to test/) → the lines carrying the shape. */
function census(): Map<string, number[]> {
  const found = new Map<string, number[]>();
  for (const abs of scannableFiles(TEST_ROOT)) {
    const rel = relative(TEST_ROOT, abs).split("\\").join("/");
    const lines = findBareGates(readFileSync(abs, "utf8"), abs);
    if (lines.length > 0) {
      found.set(rel, lines);
    }
  }
  return found;
}

describe("the scanner itself is not vacuous", () => {
  it("flags the forbidden shape, including when a formatter has split it", () => {
    expect(findBareGates("expect(syntaxTreeAvailable(s, n)).toBe(true);", "x.ts")).toHaveLength(1);
    // The case a line-oriented regex misses, which is why this is an AST walk.
    expect(
      findBareGates("expect(\n  syntaxTreeAvailable(s, n)\n).toBe(true);", "x.ts")
    ).toHaveLength(1);
    // And the same gate wearing Vitest's optional message argument.
    expect(
      findBareGates('expect(syntaxTreeAvailable(s, n), "bounded ran").toBe(true);', "x.ts")
    ).toHaveLength(1);
  });

  it("does not flag the shapes that are legitimate", () => {
    expect(findBareGates("expect(syntaxTreeAvailable(s, n)).toBe(false);", "x.ts")).toEqual([]);
    expect(findBareGates("if (syntaxTreeAvailable(s, n)) { go(); }", "x.ts")).toEqual([]);
    expect(findBareGates('const t = "expect(syntaxTreeAvailable(s)).toBe(true)";', "x.ts")).toEqual(
      []
    );
    expect(findBareGates("// expect(syntaxTreeAvailable(s)).toBe(true);", "x.ts")).toEqual([]);
  });
});

describe("no bare syntaxTreeAvailable anti-masking gate", () => {
  it("flags no test file outside the allowlist, and no extra gate inside one", () => {
    const violations: string[] = [];
    for (const [rel, lines] of census()) {
      const allowed = ALLOW.get(rel)?.count ?? 0;
      if (lines.length > allowed) {
        violations.push(
          `${rel}: ${lines.length} gate(s) at line(s) ${lines.join(", ")}, allowed ${allowed}`
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the allowlist live — every entry still carries exactly the count it excuses", () => {
    // A stale entry silently widens the guard, so an allowlisted file that no longer needs
    // its exemption, or needs a different number, must fail rather than linger.
    const found = census();
    for (const [rel, { count }] of ALLOW) {
      expect(found.get(rel)?.length ?? 0, `${rel} allowlist count is stale`).toBe(count);
    }
  });
});
