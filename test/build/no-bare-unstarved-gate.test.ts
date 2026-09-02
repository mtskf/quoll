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
//   - a non-identifier or renamed assertion receiver: `expect.soft(...)`, or an aliased
//     `import { expect as check }` — the walk requires a bare `expect` identifier
//   - a different matcher: `.toBeTruthy()`, `.toEqual(true)`, `.toBe(true as const)`, or
//     the reversed operands `expect(true).toBe(syntaxTreeAvailable(...))`
//   - a HAND-ROLLED attempt loop (`for (…) { if (runOnce()) return; }` + a trailing throw)
//     uses the conditional form and is invisible here by design; two live instances remain
//     in webview/cm-block-widget-bounded.test.ts and
//     webview/fenced-code/cm-fenced-code-collapse.test.ts
//   - INSIDE an allowlisted file, swapping a legitimate (post-forced-parse) gate for a bare
//     post-edit one at another line keeps the count identical — the pin bounds the NUMBER
//     of gates, not WHICH lines carry them
// Only the first two would need type resolution rather than a syntax walk, which is more
// machinery than this rule is worth; `url-choke-point.test.ts` accepts the same limit. The
// rest are a wider syntactic net or an accounting limit, left open deliberately: this repo
// writes the gate one way, and each extra shape is another thing to keep in step.
// `toBeTruthy()` in particular is in live use elsewhere in this suite, so read a green run
// here as evidence about the `toBe(true)` shape only. The human read of the diff is the
// backstop for the two allowlisted files — which is why the plan keeps it alongside this
// mechanised check.
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

// The extension set is WIDER than the tree it walks: every test file here is `.ts` today,
// so removing the other three alternatives reds nothing (measured) and no fixture can pin
// them. They are anticipatory, they cost nothing, and the roster test below — not this
// regex — is what pins the walk's reach.
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

/**
 * `test/`-relative path in POSIX form — the shape both the ALLOW keys and the directory
 * roster below are written in. Shared by the census and the reach test so the two cannot
 * drift apart on Windows, where only one of them normalising would compare "/"-joined
 * expectations against "\"-separated actuals.
 */
function testRelative(abs: string): string {
  return relative(TEST_ROOT, abs).split("\\").join("/");
}

/** file (relative to test/) → the lines carrying the shape. */
function census(): Map<string, number[]> {
  const found = new Map<string, number[]>();
  for (const abs of scannableFiles(TEST_ROOT)) {
    const rel = testRelative(abs);
    const lines = findBareGates(readFileSync(abs, "utf8"), abs);
    if (lines.length > 0) {
      found.set(rel, lines);
    }
  }
  return found;
}

/**
 * Census + allowlist → the violation lines. Split out of the assertion below so the
 * comparison itself can be reached by a fixture: against the real tree it is expected to
 * return nothing, which is exactly the shape that cannot tell a working comparison from one
 * that never flags anything.
 */
function violationsIn(found: Map<string, number[]>, allow: typeof ALLOW): string[] {
  const violations: string[] = [];
  for (const [rel, lines] of found) {
    const allowed = allow.get(rel)?.count ?? 0;
    if (lines.length > allowed) {
      violations.push(
        `${rel}: ${lines.length} gate(s) at line(s) ${lines.join(", ")}, allowed ${allowed}`
      );
    }
  }
  return violations;
}

describe("the scanner itself is not vacuous", () => {
  it("flags the forbidden shape, including when a formatter has split it", () => {
    // The LINE NUMBERS, not merely the count. They are the whole of what a violation hands
    // a human to find the offending gate, and a length check leaves them free to be a
    // constant: replacing the push with `hits.push(0)` survived one (measured). The three
    // fixtures sit at three DIFFERENT offsets, so no constant satisfies all of them.
    expect(findBareGates("expect(syntaxTreeAvailable(s, n)).toBe(true);", "x.ts")).toEqual([1]);
    // The case a line-oriented regex misses, which is why this is an AST walk.
    expect(findBareGates("\nexpect(\n  syntaxTreeAvailable(s, n)\n).toBe(true);", "x.ts")).toEqual([
      2,
    ]);
    // And the same gate wearing Vitest's optional message argument.
    expect(
      findBareGates('\n\n\nexpect(syntaxTreeAvailable(s, n), "bounded ran").toBe(true);', "x.ts")
    ).toEqual([4]);
  });

  it("does not flag the shapes that are legitimate", () => {
    expect(findBareGates("expect(syntaxTreeAvailable(s, n)).toBe(false);", "x.ts")).toEqual([]);
    expect(findBareGates("if (syntaxTreeAvailable(s, n)) { go(); }", "x.ts")).toEqual([]);
    expect(findBareGates('const t = "expect(syntaxTreeAvailable(s)).toBe(true)";', "x.ts")).toEqual(
      []
    );
    expect(findBareGates("// expect(syntaxTreeAvailable(s)).toBe(true);", "x.ts")).toEqual([]);
    // Nobody writes `expect()` with no arguments, so the walk's `>= 1` floor is unreachable
    // from the real tree and its removal reds nothing (measured). It is still what keeps
    // `receiver.arguments[0]` from being `undefined` one line later, and a walk that THROWS
    // fails open exactly as thoroughly as one that misses — so the floor is exercised here.
    expect(findBareGates("expect().toBe(true);", "x.ts")).toEqual([]);
  });

  // The walk is the guard's REACH. `census()` reports only files WITH hits, so a walk that
  // silently stopped descending into a clean subtree would keep every assertion below green
  // while the guard protected nothing there. Measured: skipping `decorations` and `table`
  // left all four tests passing — including the allowlist-liveness one, whose only two paths
  // lie elsewhere. Pin the roster of scanned directories instead: it is short, it changes
  // only on a deliberate restructure, and it reds the day the walk loses one. Same lesson
  // no-file-level-ts-nocheck.test.ts learned — do not leave "what is in scope" as the
  // guard's own unverified answer.
  it("scans every test subtree, not just the allowlisted ones", () => {
    const scanned = new Set(scannableFiles(TEST_ROOT).map(testRelative));
    const dirs = new Set([...scanned].map((rel) => rel.split("/").slice(0, -1).join("/")));
    for (const required of [
      "build",
      "extension",
      "markdown",
      "shared",
      "webview",
      "webview/decorations",
      "webview/table",
      "webview/fenced-code",
      "webview/helpers",
      "webview/cm/fold",
      "webview-browser",
    ]) {
      expect(dirs, `the walk no longer reaches test/${required}`).toContain(required);
    }
    // And it reaches this file, which is the cheapest proof the root is right at all.
    expect(scanned).toContain("build/no-bare-unstarved-gate.test.ts");
  });
});

describe("no bare syntaxTreeAvailable anti-masking gate", () => {
  it("flags no test file outside the allowlist, and no extra gate inside one", () => {
    expect(violationsIn(census(), ALLOW)).toEqual([]);
  });

  it("compares census against allowance in both directions", () => {
    // The assertion above expects an EMPTY list against the real tree, so it stays green
    // whether the comparison works or flags nothing at all. Two mutants survived it: a
    // `> allowed + 1` off-by-one and an unlisted-file default of 99 instead of 0. A
    // synthetic census reaches both arms.
    const allow = new Map([
      ["allowed/at-its-count.test.ts", { count: 2, reason: "fixture" }],
      ["allowed/one-too-many.test.ts", { count: 1, reason: "fixture" }],
    ]);
    expect(
      violationsIn(
        new Map([
          ["allowed/at-its-count.test.ts", [10, 20]], // exactly its allowance → not a violation
        ]),
        allow
      )
    ).toEqual([]);
    expect(violationsIn(new Map([["webview/unlisted.test.ts", [7]]]), allow)).toEqual([
      "webview/unlisted.test.ts: 1 gate(s) at line(s) 7, allowed 0",
    ]);
    expect(violationsIn(new Map([["allowed/one-too-many.test.ts", [3, 9]]]), allow)).toEqual([
      "allowed/one-too-many.test.ts: 2 gate(s) at line(s) 3, 9, allowed 1",
    ]);
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
