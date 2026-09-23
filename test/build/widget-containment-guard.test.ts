// Structural guard: every widget under src/webview/** goes through QuollWidget,
// and nothing re-opens the hooks it contains.
//
// WHY: containment lives in QuollWidget's `toDOM` / `updateDOM` / `eq` /
// `destroy` (src/webview/cm/widget-base.ts). A class that extends `WidgetType`
// directly gets none of it, and a subclass that re-declares one of those four
// names silently removes it for itself. Neither shows up in tsc, lint, or any
// behavioural test — the failure surfaces only as a wedged editor in front of a
// user (see .claude/docs/LEARNING.md on the stale-tile mechanism).
//
// WHY AN AST WALK AND NOT A REGEX: the reason test/build/no-bare-unstarved-gate
// .test.ts gives, unchanged — a line-oriented scan loses to an ordinary Biome
// reflow, and cannot tell source from a string literal or a comment. The roster
// below is derived from the SAME walk for the same reason: a raw-text
// `/extends\s+QuollWidget/` roster is vacuated by the phrase appearing in a
// comment, which is a failure this repo has already shipped once (memory
// [[quoll-source-contract-grep-vacuated-by-comment-literal]]).
//
// KNOWN GAPS (syntactic — a full answer needs a TypeChecker, which is more than
// a convention guard is worth):
//   - an aliased import: `import { WidgetType as W }` then `extends W`
//   - an intermediate base whose DECLARATION this walk never sees (one imported
//     from node_modules, or from outside `src/webview`). Intermediates declared
//     anywhere in the walked tree ARE resolved — `quollDescendants` chases `cls -> base`
//     by name, so `class Leaf extends Mid` where `Mid extends QuollWidget` is a
//     guarded widget like any other. That resolution keys on the class NAME, so
//     "class names in the walked tree are unique" is asserted below rather than
//     assumed; a collision would silently mis-resolve
//   - a widget owned by a library, given a Quoll renderer as a callback — not
//     hypothetical: `foldPlaceholderDOM` is exactly that, which is why it carries
//     its own test (Task 4) instead of relying on this guard
//   - a base picked at runtime (`extends pickBase()`)
// What it DOES cover, deliberately: class declarations AND class expressions,
// and member names written as identifiers, string literals, or computed string
// constants (`["toDOM"]()`), because those are the cheap bypasses.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "../..");
const WEBVIEW_SRC = join(__dirname, "../../src/webview");
const BASE_MODULE = join(WEBVIEW_SRC, "cm/widget-base.ts");
/** The four entry points the base contains. A subclass re-declaring any of them
 *  takes back the containment for itself. */
const GUARDED = ["toDOM", "updateDOM", "eq", "destroy"];
/** Uncontained hooks whose override should be a deliberate, reviewed decision
 *  rather than a default — `estimatedHeight` / `lineBreaks` are read after state
 *  installation (`@codemirror/view/dist:5954`, after `:6233`) and `coordsAt`
 *  during measurement, so a throwing one is the same hazard in a new place. No
 *  widget overrides any of them today.
 *
 *  ⚠️ `ignoreEvent` is deliberately NOT here: all eight widgets override it, by
 *  design, and it is uncontained on purpose (the base's header says why). Listing
 *  it would make this guard fail on the healthy tree — which is exactly what an
 *  earlier draft of this plan did. */
const UNGUARDED = ["estimatedHeight", "lineBreaks", "coordsAt"];

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? tsFiles(full) : full.endsWith(".ts") ? [full] : [];
  });
}

type Widget = {
  file: string;
  cls: string;
  base: string;
  members: string[];
  /** The `widgetName` property's string-literal initialiser, when it has one.
   *  It is half of the log's latch key and the whole of the placeholder stamp. */
  widgetName: string | undefined;
};

/** Resolve `base` through intermediate classes the walk has seen, and keep only
 *  the ones that bottom out at `QuollWidget`.
 *
 *  WHY: `base` is heritage-clause TEXT (`t.expression.getText(sf)`), so before
 *  this a `class Leaf extends Mid` — with `Mid extends QuollWidget` declared
 *  right beside it — read as base `"Mid"` and fell out of ALL THREE consumers at
 *  once: the re-declaration check, the roster, and the listener scan. One
 *  intermediate class was enough to leave a widget completely unguarded.
 *
 *  ⚠️ Resolution is by NAME across the whole walk (a per-file map would reopen
 *  the same hole for a base imported from a sibling module). The `seen` set
 *  makes a cycle terminate instead of overflowing, and an unknown base name
 *  stays opaque — the declared gap in the header.
 *
 *  ⚠️ It asks "is `QuollWidget` ANYWHERE in this ancestry", not "what is the
 *  root of it". `QuollWidget extends WidgetType` is itself in the walked tree,
 *  so a root-of-the-chain formulation walks straight past it and resolves every
 *  real widget to `"WidgetType"` — measured: it emptied the roster while the
 *  planted-string non-vacuity case, which has no `QuollWidget` declaration in
 *  it to walk through, stayed green. */
function quollDescendants(classes: Widget[]): Widget[] {
  const baseOf = new Map(classes.map((c) => [c.cls, c.base]));
  const descendsFromBase = (name: string, seen = new Set<string>()): boolean => {
    if (name === "QuollWidget") {
      return true;
    }
    const next = baseOf.get(name);
    return next === undefined || seen.has(name) ? false : descendsFromBase(next, seen.add(name));
  };
  return classes.filter((c) => descendsFromBase(c.base));
}

/** Every local (`./` / `../`) module reachable from `entries`, transitively.
 *
 *  WHY the listener scan reads this instead of a hand-written list: the roster
 *  is derived from the AST and follows the tree, but the scan's file set used to
 *  be the widget files plus one hard-coded helper. The moment a helper that
 *  `render` / `patchDOM` calls moved into a NEW file, an `addEventListener`
 *  there with no `{ signal }` — the exact defect this base class exists to
 *  close — was invisible to the guard while it stayed green. */
function importClosure(entries: string[]): string[] {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) {
      continue;
    }
    seen.add(file);
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const st of sf.statements) {
      const spec =
        (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) &&
        st.moduleSpecifier !== undefined &&
        ts.isStringLiteral(st.moduleSpecifier)
          ? st.moduleSpecifier.text
          : undefined;
      if (spec === undefined || !spec.startsWith(".")) {
        continue; // a package, not ours to scan
      }
      // The repo writes local specifiers with the emitted `.js` extension.
      const stem = resolve(dirname(file), spec.replace(/\.js$/, ""));
      for (const candidate of [`${stem}.ts`, join(stem, "index.ts")]) {
        if (existsSync(candidate)) {
          queue.push(candidate);
          break;
        }
      }
    }
  }
  return [...seen].sort();
}

/** Every `addEventListener(...)` call in `text` that does NOT pass an options
 *  argument carrying a `signal` property. A missed `{ signal }` is not a type
 *  error — it is a listener that outlives its element, which is the failure this
 *  PR exists to close — so it has to be a mechanism, not a review habit. */
function unscopedListeners(text: string, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "addEventListener"
    ) {
      const opts = node.arguments[2];
      const scoped =
        opts !== undefined &&
        ts.isObjectLiteralExpression(opts) &&
        opts.properties.some((prop) => prop.name?.getText(sf) === "signal");
      if (!scoped) {
        out.push(`${fileName}:${sf.getLineAndCharacterOfPosition(node.pos).line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return out;
}

/** Every class in `text` that extends something, with its member names. Takes a
 *  STRING, not a path, so the non-vacuity test can plant a violation without
 *  writing into `src/` — where `pnpm compile`, Biome and three other source
 *  scanners run concurrently under `/parallel-checks`. */
function widgetsIn(text: string, fileName: string): Widget[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const out: Widget[] = [];
  const memberName = (m: ts.ClassElement): string | undefined => {
    const n = m.name;
    if (n === undefined) {
      return undefined;
    }
    if (ts.isIdentifier(n) || ts.isStringLiteral(n)) {
      return n.text;
    }
    // `["toDOM"]() {}` — a computed name whose expression is a string literal.
    if (ts.isComputedPropertyName(n) && ts.isStringLiteralLike(n.expression)) {
      return n.expression.text;
    }
    return undefined;
  };
  const visit = (node: ts.Node): void => {
    // Declarations AND expressions: `const W = class extends WidgetType {}`
    // is the cheapest way past a declaration-only walk.
    if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.heritageClauses) {
      const base = node.heritageClauses
        .filter((h) => h.token === ts.SyntaxKind.ExtendsKeyword)
        .flatMap((h) => h.types)
        .map((t) => t.expression.getText(sf))[0];
      if (base !== undefined) {
        out.push({
          file: fileName,
          cls: node.name?.getText(sf) ?? "(anonymous)",
          base,
          members: node.members.map(memberName).filter((n): n is string => n !== undefined),
          widgetName: node.members
            .filter(ts.isPropertyDeclaration)
            .filter((m) => ts.isIdentifier(m.name) && m.name.text === "widgetName")
            .map((m) =>
              m.initializer !== undefined && ts.isStringLiteralLike(m.initializer)
                ? m.initializer.text
                : undefined
            )
            .at(-1),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return out;
}

function violations(classes: Widget[]): string[] {
  const out: string[] = [];
  for (const c of classes) {
    // Stays a LITERAL check: if an intermediate extends WidgetType directly then
    // that intermediate is itself flagged here, and saying the same of every
    // leaf below it would be both noisy and untrue.
    if (c.base === "WidgetType" && c.file !== BASE_MODULE) {
      out.push(`${c.file}: ${c.cls} extends WidgetType directly`);
    }
  }
  for (const c of quollDescendants(classes)) {
    for (const m of c.members) {
      if (GUARDED.includes(m)) {
        out.push(`${c.file}: ${c.cls} re-declares the guarded hook '${m}'`);
      }
      if (UNGUARDED.includes(m)) {
        out.push(
          `${c.file}: ${c.cls} overrides the UNCONTAINED hook '${m}' — see the guard's header`
        );
      }
    }
  }
  return out.sort();
}

describe("widget containment cannot be bypassed", () => {
  const classes = tsFiles(WEBVIEW_SRC).flatMap((f) => widgetsIn(readFileSync(f, "utf8"), f));
  const widgetClasses = quollDescendants(classes);

  it("nothing extends WidgetType directly, re-declares a guarded hook, or overrides an uncontained one", () => {
    expect(violations(classes)).toEqual([]);
  });

  it("class names in the walked tree are unique (the base resolver keys on the NAME)", () => {
    // `quollDescendants` chases `cls -> base` by name across every file, so two
    // classes sharing a name would silently resolve one of them to the other's
    // ancestry. Asserting the premise costs one line; discovering it broken by
    // way of a widget that quietly left the roster does not.
    const named = classes.filter((c) => c.cls !== "(anonymous)").map((c) => c.cls);
    expect(new Set(named).size).toBe(named.length);
  });

  it("the roster is what we think it is (a new widget must be a deliberate edit)", () => {
    // Derived from the same AST walk, not a text regex — see the header.
    const widgets = widgetClasses.map((c) => c.file.slice(WEBVIEW_SRC.length + 1)).sort();
    expect(widgets).toEqual([
      "cm/decorations/thematic-break-widget.ts",
      "cm/fenced-code/fenced-code-collapse-widget.ts",
      "cm/fenced-code/fenced-code-copy-button-widget.ts",
      "cm/fenced-code/fenced-code-language-picker-widget.ts",
      "cm/frontmatter/frontmatter-widget.ts",
      "cm/image/image-widget.ts",
      "cm/table/table-widget.ts",
      "cm/task-checkbox/task-checkbox-widget.ts",
    ]);
  });

  it("every widget's latch key is distinct (a duplicate swallows the other's only log line)", () => {
    // `reportOnce` latches on `${hook}:${widgetName}` and the placeholder stamps
    // `data-quoll-widget-error="<widgetName>"`. The base's long justification for
    // a PER-(hook, widget) latch — rather than one boolean for the session —
    // rests entirely on these literals being distinct between classes, and
    // nothing else enforces it: two classes can carry the same string literal
    // with `pnpm compile` green, and the roster test above pins FILES, not names.
    const names = widgetClasses.map((c) => c.widgetName);
    expect(names.filter((n) => n === undefined)).toEqual([]); // every widget declares one
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBe(8); // roster count, same convention as the roster test
  });

  // Every module a widget can reach through local imports — DERIVED, not listed.
  const scanned = importClosure(widgetClasses.map((c) => c.file));

  it("the listener scan follows helpers transitively, not a hand-written list", () => {
    // `cell-source-map.ts` is imported by `cell-render.ts`, which is imported by
    // `table-widget.ts` — depth 2. The hand-written list this replaced named
    // `cell-render.ts` explicitly and stopped there, so a helper split out of a
    // helper was outside the scan. If the closure ever stops walking, this goes
    // red instead of the scan quietly narrowing to nothing.
    expect(scanned).toContain(join(WEBVIEW_SRC, "cm/table/cell-render.ts"));
    expect(scanned).toContain(join(WEBVIEW_SRC, "cm/table/cell-source-map.ts"));
    // …and every widget module is still an entry point of it.
    for (const c of widgetClasses) {
      expect(scanned).toContain(c.file);
    }
  });

  it("every listener a widget binds is scoped to an AbortSignal", () => {
    const unscoped = scanned.flatMap((f) =>
      unscopedListeners(readFileSync(f, "utf8"), f.slice(REPO_ROOT.length + 1))
    );
    // ⚠️ MEASURED, not taken from the plan: the table arms its DOCUMENT-level
    // drag listeners (mouseup / mousedown-capture / dragstart) from inside a
    // handler, not from a hook, and owns them through its OWN bespoke
    // `AbortController` (`release`, table-widget.ts) rather than the base's
    // per-render `signal` — `dispose` (`TableBlockWidget.dispose`) aborts it.
    // The scan below checks for a property literally NAMED `signal` in the
    // third argument, regardless of which controller it reads from — so
    // `{ signal: release.signal, capture: true }` counts as SCOPED exactly like
    // `{ signal }` does. The plan's draft assumed these 3 document-level sites
    // would read as unscoped by this check; run against the real tree they do
    // not (property NAME match, not source-identity match), so the count here
    // is 0, confirmed by running this test — not 3. Both the root `mousedown` /
    // `click` listeners (bound during `render`, the base's own signal) and the
    // 3 document-level ones (their own signal, same property name) are scoped.
    // An EMPTY list, not a count, per the repo's allowlist convention: a NEW
    // unscoped listener anywhere the widgets can reach must argue for itself in
    // the same commit — and because the file set is now the derived import
    // closure (41 modules as measured, versus the 9 the hand-written list
    // covered), "anywhere they can reach" is what it says.
    expect(unscoped).toEqual([]);
  });

  it("non-vacuity: the listener scan flags a missing signal and passes a present one", () => {
    expect(unscopedListeners(`el.addEventListener("click", f);`, "x.ts")).toHaveLength(1);
    expect(
      unscopedListeners(`el.addEventListener("click", f, { passive: true });`, "x.ts")
    ).toHaveLength(1);
    expect(unscopedListeners(`el.addEventListener("click", f, { signal });`, "x.ts")).toEqual([]);
  });

  it("non-vacuity: the walk flags every planted bypass", () => {
    // Planted as a STRING through the same entry point the real scan uses, so a
    // broken walk goes red here instead of reporting a clean tree. Nothing is
    // written to disk.
    const planted = `
      import { WidgetType } from "@codemirror/view";
      import { QuollWidget } from "./widget-base.js";
      export class Bare extends WidgetType {}
      export const Anon = class extends WidgetType {};
      export class Reopened extends QuollWidget { toDOM() { return null as never; } }
      export class Computed extends QuollWidget { ["updateDOM"]() { return false; } }
      export class Heighted extends QuollWidget { get estimatedHeight() { return 1; } }
      export class Fine extends QuollWidget { render() { return null as never; } }
      // An INTERMEDIATE base. Before \`quollDescendants\` chased the base chain,
      // \`Leaf\` read as base "Mid" and dropped out of the re-declaration check,
      // the roster and the listener scan all at once — one class between a
      // widget and the base was enough to unguard it, in the same file.
      export class Mid extends QuollWidget {}
      export class Leaf extends Mid { toDOM() { return null as never; } }
      // ⚠️ Must NOT be flagged — every real widget has one.
      export class Eventful extends QuollWidget { ignoreEvent() { return false; } }
    `;
    const got = violations(widgetsIn(planted, "planted.ts"));
    expect(got).toEqual([
      "planted.ts: (anonymous) extends WidgetType directly",
      "planted.ts: Bare extends WidgetType directly",
      "planted.ts: Computed re-declares the guarded hook 'updateDOM'",
      "planted.ts: Heighted overrides the UNCONTAINED hook 'estimatedHeight' — see the guard's header",
      "planted.ts: Leaf re-declares the guarded hook 'toDOM'",
      "planted.ts: Reopened re-declares the guarded hook 'toDOM'",
    ]);
  });
});
