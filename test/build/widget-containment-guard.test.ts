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
//     from node_modules, or from outside `src/webview`). An intermediate DECLARED
//     anywhere in the walked tree is resolved — `quollDescendants` chases
//     `cls -> base` by name, so `class Leaf extends Mid` where
//     `class Mid extends QuollWidget` stands anywhere in the tree is a guarded
//     widget like any other. ⚠️ Resolution keys on the identifier a subclass
//     writes after `extends`, which is the DECLARED name and nothing else: a
//     class EXPRESSION is therefore NOT resolved even though the walk sees it
//     (`const Mid = class Inner …` is reachable only as `Mid` while `baseOf` gets
//     the key `Inner`, and an anonymous one contributes no key at all). That is
//     why every class expression in a `QuollWidget` ancestry is reported as a
//     violation below rather than left to this gap. The same name-keyed
//     resolution is why "class names in the walked tree are unique" is asserted
//     below rather than assumed; a collision would silently mis-resolve
//   - a hook replaced OUTSIDE the class body: `X.prototype.<hook> = …`,
//     `Object.defineProperty(X.prototype, "<hook>", …)`, or either of those
//     reached through a bound alias (`const P = X.prototype; P.destroy = …`).
//     The member walk reads `node.members` PLUS `this.<name> = …` written inside
//     the class body, so a re-declaration (method or class field) and a
//     constructor assignment are both visible and nothing outside the class body
//     is. Measured green for all three. Closing them needs a second name-keyed
//     resolution of `X` against the class roster, and the bound-alias form cannot
//     be followed syntactically at all
//   - indirect listener-registration spellings: `el.addEventListener.call(…)` /
//     `.apply(…)` / `.bind(…)`, `Reflect.apply(el.addEventListener, …)`, and
//     `Object.assign(el, { onclick })`. The scan matches the callee and the
//     assignment target by NAME; the options argument sits in a different place
//     in each of those spellings, and a bound alias needs a TypeChecker.
//     Measured green for all of them
//   - a widget owned by a library, given a Quoll renderer as a callback — not
//     hypothetical: `foldPlaceholderDOM` is exactly that, which is why it carries
//     its own test (Task 4) instead of relying on this guard. ⚠️ The LISTENER
//     scan inherits that gap, and it bites: the scan's file set is the import
//     closure of the widget modules (41 modules as measured), and
//     `cm/fold/index.ts` is not in it, so the `el.onclick = onclick` at `:171` —
//     a real unabortable handler — is NOT reported. It is reached only by
//     CodeMirror's own fold widget, so no `QuollWidget` teardown owns it either
//     way; `widget-base.test.ts`'s `containWidgetRender` case is what covers
//     that file. Named here because the `on*` arm below would otherwise read as
//     a promise about the whole tree.
//   - a base picked at runtime (`extends pickBase()`)
// What it DOES cover, deliberately, because these are the cheap bypasses:
//   - class declarations AND class expressions — and a class expression that
//     descends from `QuollWidget` is itself a violation whether or not it is
//     named, since `quollDescendants` resolves bases by the `extends` identifier
//     and a class expression's own name is not that identifier
//   - class MEMBER names written as identifiers, string literals, or computed
//     string constants (`["toDOM"]()`), AND `this.<name> = …` written inside the
//     class body — a constructor assignment installs the same own property a
//     class FIELD does, and only the spelling differs. ⚠️ This is about the names
//     a class takes over; how a CALL's callee — or an `on*` assignment target —
//     is spelled is the separate job of the module-level `accessedName`
//   - listener registrations in both call spellings (`el.addEventListener(…)`
//     and `el["addEventListener"](…)`) and `on*` property handlers in every
//     assignment spelling (`el.onclick = f`, `el["onclick"] = f`, and the
//     logical assignments `??=` / `||=` / `&&=`)
// ⚠️ The `on*` arm is a deliberate OVER-approximation: it matches an `on*`
// assignment TARGET in any of those spellings, including one on a non-element
// target. Measured, the whole
// `src/webview` tree holds three (`fold/index.ts:171`, and `image-paste.ts`'s
// `reader.onload` / `reader.onerror` on a `FileReader`), all of them outside the
// scanned closure today. A future reader who pulls `image-paste.ts` into the
// closure will get a report that is technically right — a `FileReader` handler
// is no more abortable than an element's — but about a non-element; decide it
// then rather than narrowing the arm now for a case that does not exist.

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
 *  installation (`@codemirror/view/dist:5954` / `:5955`, and both again in
 *  `heightRelevant` `:353`, all after `:6233`) and `coordsAt` during measurement
 *  (`:2112`), so a throwing one is the same hazard in a new place. No widget
 *  overrides any of them today.
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
  /** A class EXPRESSION's declared name is not the identifier a subclass writes
   *  after `extends` — `const Mid = class Inner …` is reachable only as `Mid`,
   *  and `baseOf` keys on `cls`. So EVERY class expression in an ancestry is
   *  unresolvable, named or not, which is why this is a property of the record
   *  rather than something encoded in a sentinel `cls` string. */
  isExpression: boolean;
  members: string[];
  /** Names the class takes over by ASSIGNMENT inside its own body
   *  (`constructor() { this.destroy = … }`) rather than by declaration. Kept
   *  apart from `members` only so the report can name which form it saw; at
   *  runtime the two are the same own property. */
  assigned: string[];
  /** The `widgetName` property's string-literal initialiser, when it has one.
   *  It is half of the log's latch key and the whole of the placeholder stamp. */
  widgetName: string | undefined;
};

/** The property name in `x.f` and `x["f"]` alike — BOTH spellings, because the
 *  bracket form is the same access and was the measured bypass. `undefined` for
 *  anything else (a computed name this walk cannot read).
 *
 *  ⚠️ MODULE scope, deliberately. It began as a `const` inside `unscopedListeners`,
 *  and the bracket bypass it closes there promptly reopened in a SIBLING walk:
 *  `containWidgetRenderNames` matched a bare-identifier callee only, so
 *  `base.containWidgetRender("X", …)` was silently skipped one cycle after the
 *  identical shape was closed for `addEventListener`. A resolution rule that
 *  lives inside one walk gets re-derived — or forgotten — by the next one, so the
 *  rule is one definition and the walks share it: the CALLEE of
 *  `x.addEventListener(…)` and `x.containWidgetRender(…)`, and the assignment
 *  TARGET of `x.onclick =` and `this.destroy =`.
 *
 *  A bare identifier deliberately stays `undefined`. The only caller that needs
 *  one asks for it itself (`containWidgetRenderNames`); widening this instead
 *  would silently add bare `addEventListener(…)` / `onclick = f` — implicit
 *  globals — to the listener scan's report, which is a different decision about a
 *  shape this tree does not contain. */
const accessedName = (node: ts.Node): string | undefined => {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return undefined;
};

/** Every assignment operator that INSTALLS a value on the left-hand side. The
 *  logical three are here because `el.onclick ??= f` leaves exactly the same
 *  unabortable handler on the element that `el.onclick = f` does — the operator
 *  changes when the write happens, never whether the listener can be removed. */
const ASSIGNMENT_TOKENS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
]);

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

/** Every listener registration in `text` that no `AbortSignal` can ever remove.
 *  A missed `{ signal }` is not a type error — it is a listener that outlives
 *  its element, which is the failure this PR exists to close — so it has to be a
 *  mechanism, not a review habit.
 *
 *  Two shapes, because both were measured walking past the dotted-call-only
 *  version of this predicate while it reported a clean tree:
 *    - `x.addEventListener(…)` AND `x["addEventListener"](…)` without a `signal`
 *      property in the options argument. The bracket form is the same call; only
 *      the spelling of the callee differs, and `widgetsIn`'s `memberName` already
 *      resolves computed string names for class MEMBERS — that handling was never
 *      carried over here.
 *    - `x.onclick = f` / `x["onclick"] = f`, and the same two targets under the
 *      logical assignments `??=` / `||=` / `&&=`. Reported unconditionally, with
 *      no options to inspect: an `on*` property handler has no registration
 *      options at all, so no `AbortSignal` can reach it and `QuollWidget.destroy`
 *      → `abortListeners` cannot remove it. That is precisely the class the base
 *      exists to close, so it is a violation in every form. */
function unscopedListeners(text: string, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  // `getStart(sf)`, NOT `node.pos`, at every report site below: `pos` is the FULL
  // start (leading trivia included), so in this comment-heavy tree it names the
  // line of the PREVIOUS token — measured 19 lines early for cell-render.ts's
  // `auxclick` guard (`:104` reported, `:123` real, the closing `);` of a
  // different call). This line is the test's only actionable output.
  const at = (node: ts.Node): string =>
    `${fileName}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
  /** `x.onfoo` / `x["onfoo"]` as an assignment TARGET, in EVERY assignment
   *  spelling. `??=` / `||=` / `&&=` install a handler exactly as `=` does and no
   *  `AbortSignal` can remove any of them, so resting the check on one token is
   *  the same bet the dotted-callee-only version of this predicate already lost —
   *  three tokens, and the arm stops being a statement about syntax. */
  const onHandlerTarget = (node: ts.Node): ts.Node | undefined => {
    if (!ts.isBinaryExpression(node) || !ASSIGNMENT_TOKENS.has(node.operatorToken.kind)) {
      return undefined;
    }
    const name = accessedName(node.left);
    return name !== undefined && /^on[a-z]+$/.test(name) ? node.left : undefined;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && accessedName(node.expression) === "addEventListener") {
      const opts = node.arguments[2];
      const scoped =
        opts !== undefined &&
        ts.isObjectLiteralExpression(opts) &&
        opts.properties.some((prop) => prop.name?.getText(sf) === "signal");
      if (!scoped) {
        out.push(at(node));
      }
    }
    const handler = onHandlerTarget(node);
    if (handler !== undefined) {
      out.push(`${at(handler)} (on* property handler — bind with addEventListener + { signal })`);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return out;
}

/** Every name a class takes over by writing `this.<name> = …` (or
 *  `this["<name>"] = …`) inside its OWN body — `constructor() { this.destroy =
 *  … }` being the shape that matters.
 *
 *  WHY it is collected at all: it installs the very same own property a class
 *  FIELD does, which `memberName` already sees, so treating one as a bypass and
 *  the other as invisible would rest the guard on a spelling — the mistake the
 *  bracket-callee form already cost this file once.
 *
 *  ⚠️ What it does NOT reach, and why that is a declared gap rather than an
 *  oversight: `X.prototype.destroy = …` and `Object.defineProperty(X.prototype,
 *  …)` sit OUTSIDE the class body, so seeing them means resolving `X` back to a
 *  class by name — a second name-keyed resolution alongside `baseOf` — and the
 *  bound-alias form (`const P = X.prototype`) needs a TypeChecker. Both are in
 *  the header's KNOWN GAPS, measured.
 *
 *  ⚠️ Deliberately over-approximating in two directions, because a guard should
 *  err loud: it reads the whole class body rather than the constructor only, and
 *  a nested `function () { this.destroy = … }` rebinds `this` yet is still
 *  attributed here. It stops at a nested CLASS, though — that `this` provably
 *  belongs to someone else. */
function assignedNames(cls: ts.ClassLikeDeclaration): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      return; // a different class's `this`
    }
    if (
      ts.isBinaryExpression(node) &&
      ASSIGNMENT_TOKENS.has(node.operatorToken.kind) &&
      (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) &&
      node.left.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      const name = accessedName(node.left);
      if (name !== undefined) {
        out.push(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const member of cls.members) {
    ts.forEachChild(member, visit);
  }
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
          isExpression: ts.isClassExpression(node),
          members: node.members.map(memberName).filter((n): n is string => n !== undefined),
          assigned: assignedNames(node),
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

/** Every name passed to a `containWidgetRender("…", …)` call, in every callee
 *  spelling the walk can resolve — `containWidgetRender(…)`,
 *  `base.containWidgetRender(…)` and `m["containWidgetRender"](…)` alike. It is
 *  the name the callee RESOLVES to that decides, never how it is written: the
 *  bare-identifier-only version of this walk skipped the other two silently, one
 *  cycle after the identical bypass was closed for `addEventListener` — which is
 *  why the resolution now comes from the shared module-level `accessedName`
 *  rather than from a rule re-derived here.
 *
 *  WHY this is part of the latch-key set and not a separate concern: the name a
 *  caller hands `containWidgetRender` feeds `reportOnce("render", name, err)`
 *  and `makePlaceholder(…, name)` — the SAME `${hook}:${widget}` latch and the
 *  same `data-quoll-widget-error` stamp a subclass's `widgetName` produces. A
 *  literal here colliding with a subclass's `widgetName` swallows one of the two
 *  log lines exactly as two colliding subclasses would, and collecting only
 *  class declarations cannot see it. `widget-base.ts` is excluded because its own
 *  call passes `this.widgetName` — the subclass roster, already counted.
 *
 *  A non-literal first argument THROWS rather than being skipped: skipping is how
 *  a guard quietly narrows, and the throw names the file so the next author
 *  decides deliberately. An ALIASED import throws for the same reason — it
 *  renames the callee out of a by-name walk's reach entirely, and no syntactic
 *  match can follow it, so the one honest answer is to refuse it out loud. */
function containWidgetRenderNames(text: string, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const CALLEE = "containWidgetRender";
  for (const st of sf.statements) {
    const bindings = ts.isImportDeclaration(st) ? st.importClause?.namedBindings : undefined;
    if (bindings === undefined || !ts.isNamedImports(bindings)) {
      continue;
    }
    for (const el of bindings.elements) {
      if (el.propertyName?.text === CALLEE) {
        throw new Error(
          `${fileName}: ${CALLEE} is imported as '${el.name.text}' — this guard matches the callee by name, so import it unaliased`
        );
      }
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      // The callee's SPELLING is not the question — the name it resolves to is.
      const callee = ts.isIdentifier(node.expression)
        ? node.expression.text
        : accessedName(node.expression);
      if (callee === CALLEE) {
        const arg = node.arguments[0];
        if (arg === undefined || !ts.isStringLiteralLike(arg)) {
          throw new Error(
            `${fileName}: ${CALLEE}'s widget name must be a string literal so this guard can see it (got ${arg?.getText(sf) ?? "no argument"})`
          );
        }
        out.push(arg.text);
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
    // A class EXPRESSION in the ancestry defeats the whole walk, not just this
    // check: `baseOf` is keyed on `cls`, which is the class's own DECLARED name,
    // while a subclass can only write the identifier the expression is BOUND to.
    // The two are never the same thing, so `class Leaf extends Mid` below a
    // `const Mid = class … extends QuollWidget {}` resolves to nothing and leaves
    // `widgetClasses` entirely — taking the re-declaration check, the roster and
    // the latch key with it, while the intermediate keeps the roster's file count
    // and `widgetName` looking untouched. Measured: with that shape planted in
    // thematic-break-widget.ts the guard was 8/8 GREEN.
    //
    // ⚠️ NAMING THE EXPRESSION DOES NOT HELP, which is why this keys on
    // `isExpression` and not on a `"(anonymous)"` sentinel: `const Mid = class
    // Inner extends QuollWidget {}` puts the key `Inner` in `baseOf` while every
    // subclass writes `extends Mid`, so the leaf drops out exactly as it does
    // under an anonymous one (re-measured: `descendants` holds `Inner` alone).
    // Distinct from the header's declared gap ("an intermediate base whose
    // DECLARATION this walk never sees"): this one IS seen. The fix is a class
    // DECLARATION, so that is what the message asks for.
    if (c.isExpression) {
      out.push(
        `${c.file}: ${c.cls} is a class expression descending from QuollWidget — declare it with \`class ${c.cls === "(anonymous)" ? "<Name>" : c.cls} extends …\`, the base resolver keys on the \`extends\` identifier`
      );
    }
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
    // Same containment loss, different spelling: `this.destroy = …` in a
    // constructor installs the own property a class field would, so the verb is
    // the only thing that separates these two reports.
    for (const m of c.assigned) {
      if (GUARDED.includes(m)) {
        out.push(`${c.file}: ${c.cls} assigns over the guarded hook '${m}'`);
      }
      if (UNGUARDED.includes(m)) {
        out.push(
          `${c.file}: ${c.cls} assigns over the UNCONTAINED hook '${m}' — see the guard's header`
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

  it("every latch key is distinct (a duplicate swallows the other's only log line)", () => {
    // `reportOnce` latches on `${hook}:${widgetName}` and the placeholder stamps
    // `data-quoll-widget-error="<widgetName>"`. The base's long justification for
    // a PER-(hook, widget) latch — rather than one boolean for the session —
    // rests entirely on these literals being distinct, and nothing else enforces
    // it: two of them can carry the same string with `pnpm compile` green, and
    // the roster test above pins FILES, not names.
    //
    // ⚠️ The set is the SUBCLASSES PLUS every `containWidgetRender` caller
    // outside the base module — in any callee spelling, see the walk — because a
    // name reaching the latch does not have to come from a
    // class: `containWidgetRender(name, …)` feeds `name` to `reportOnce` and
    // `makePlaceholder` itself. Collecting only `widgetClasses` covered 8 of the
    // 9 names in the tree — `foldPlaceholderDOM`'s `"foldPlaceholder"` sat
    // outside the walk while the base's comment named this walk as the
    // enforcement. Measured: renaming that literal to a widget's `widgetName`
    // produced a real collision that the class-only version reported as green.
    const names = [
      ...widgetClasses.map((c) => c.widgetName),
      ...tsFiles(WEBVIEW_SRC)
        .filter((f) => f !== BASE_MODULE) // its own call passes `this.widgetName`
        .flatMap((f) => containWidgetRenderNames(readFileSync(f, "utf8"), f)),
    ];
    expect(names.filter((n) => n === undefined)).toEqual([]); // every widget declares one
    expect(new Set(names).size).toBe(names.length);
    // 8 `QuollWidget` subclasses (the roster above) + 1 direct caller
    // (`cm/fold/index.ts`'s `"foldPlaceholder"`). Same convention as the roster
    // test: a new one must be a deliberate edit here.
    expect(names.length).toBe(9);
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
    // drag listeners (mouseup / mousedown / dragstart — ALL THREE in CAPTURE,
    // see table-widget.ts:671-687 for why that is load-bearing on the mouseup
    // too) from inside a handler, not from a hook, and owns them through its OWN
    // bespoke
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
    // The bracket spelling is the SAME call — it goes through the same
    // `{ signal }` check, so it is flagged when unscoped and cleared when not.
    // (A blanket ban on the spelling would pass the first of these two and be
    // wrong about the second.)
    expect(unscopedListeners(`el["addEventListener"]("click", f);`, "x.ts")).toHaveLength(1);
    expect(unscopedListeners(`el["addEventListener"]("click", f, { signal });`, "x.ts")).toEqual(
      []
    );
    // `on*` handlers have no options to inspect — no signal can reach them, so
    // both spellings are flagged unconditionally.
    expect(unscopedListeners(`el.onclick = f;`, "x.ts")).toHaveLength(1);
    expect(unscopedListeners(`el["onchange"] = f;`, "x.ts")).toHaveLength(1);
    // …and in every assignment spelling. `??=` / `||=` / `&&=` leave exactly the
    // same unabortable handler on the element, so a predicate that reads only
    // `=` is a statement about syntax rather than about listeners.
    expect(unscopedListeners(`el.onclick ??= f;`, "x.ts")).toHaveLength(1);
    expect(unscopedListeners(`el.onclick ||= f;`, "x.ts")).toHaveLength(1);
    expect(unscopedListeners(`el["onclick"] &&= f;`, "x.ts")).toHaveLength(1);
    // …but only `on*`: an ordinary property assignment is not a registration.
    expect(unscopedListeners(`el.online = f;`, "x.ts")).toHaveLength(1); // matches /^on[a-z]+$/
    expect(unscopedListeners(`el.className = f;`, "x.ts")).toEqual([]);
    expect(unscopedListeners(`el.className ??= f;`, "x.ts")).toEqual([]);
  });

  it("non-vacuity: the reported line is the CALL's line, not its leading trivia's", () => {
    // `node.pos` is the FULL start, so it names the previous token's line — in
    // the real `cell-render.ts` that was 19 lines early for the `auxclick`
    // guard, pointing at the closing `);` of a different call. This is the sole
    // actionable output of `expect(unscoped).toEqual([])` above, so the line
    // number is a contract, not a detail. One-line fixtures cannot see the
    // difference (`pos` and `getStart` agree there), hence the trivia here.
    expect(
      unscopedListeners(
        `const x = 1;\n// leading\n/* trivia */\nel.addEventListener("click", f);`,
        "x.ts"
      )
    ).toEqual(["x.ts:4"]);
    expect(unscopedListeners(`const x = 1;\n// leading\nel.onclick = f;`, "x.ts")).toEqual([
      "x.ts:3 (on* property handler — bind with addEventListener + { signal })",
    ]);
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
      // An ANONYMOUS intermediate. \`baseOf\` gets no key for it, so a leaf below
      // it resolves to nothing and drops out of the re-declaration check, the
      // roster AND the latch key at once — while the intermediate itself keeps
      // the roster's file count and its \`widgetName\` looking untouched. Flagged
      // at the intermediate, which is where the declaration is missing.
      export const AnonMid = class extends QuollWidget {};
      // A NAMED class expression is no more resolvable, and this pair is here so
      // the two cannot drift apart: \`baseOf\` gets the key \`Inner\`, while the
      // only identifier a subclass can write is \`AliasMid\`. So \`AliasLeaf\`
      // contributes NO entry below — it falls out of \`quollDescendants\` exactly
      // as it would under the anonymous form, which is the whole finding. The
      // loud report has to come from the expression itself.
      export const AliasMid = class Inner extends QuollWidget {};
      export class AliasLeaf extends AliasMid { toDOM() { return null as never; } }
      // The hook taken over by ASSIGNMENT rather than declaration. Runtime-
      // identical to the class field \`destroy = (dom) => {}\`, which the member
      // walk already collects — only the spelling differs.
      export class Assigned extends QuollWidget {
        constructor() { super(); this.destroy = () => {}; }
      }
      // ⚠️ Must NOT be flagged — every real widget has one.
      export class Eventful extends QuollWidget { ignoreEvent() { return false; } }
    `;
    const got = violations(widgetsIn(planted, "planted.ts"));
    expect(got).toEqual([
      "planted.ts: (anonymous) extends WidgetType directly",
      "planted.ts: (anonymous) is a class expression descending from QuollWidget — declare it with `class <Name> extends …`, the base resolver keys on the `extends` identifier",
      "planted.ts: Assigned assigns over the guarded hook 'destroy'",
      "planted.ts: Bare extends WidgetType directly",
      "planted.ts: Computed re-declares the guarded hook 'updateDOM'",
      "planted.ts: Heighted overrides the UNCONTAINED hook 'estimatedHeight' — see the guard's header",
      "planted.ts: Inner is a class expression descending from QuollWidget — declare it with `class Inner extends …`, the base resolver keys on the `extends` identifier",
      "planted.ts: Leaf re-declares the guarded hook 'toDOM'",
      "planted.ts: Reopened re-declares the guarded hook 'toDOM'",
    ]);
  });

  it("non-vacuity: a non-literal containWidgetRender name fails loudly rather than being skipped", () => {
    // Skipping is how a guard quietly narrows: a name the walk cannot read is a
    // name it cannot check for collision, and silence there is indistinguishable
    // from "no collision". The throw names the file so the next author decides.
    expect(() =>
      containWidgetRenderNames(`containWidgetRender(NAME, () => el);`, "planted.ts")
    ).toThrow(/must be a string literal/);
    expect(containWidgetRenderNames(`containWidgetRender("Lit", () => el);`, "planted.ts")).toEqual(
      ["Lit"]
    );
    // The qualified spellings are the SAME call — the callee resolves to the
    // same name, so they are collected the same way. A bare-identifier-only
    // match skipped both silently, which is how this guard quietly narrowed one
    // cycle after the identical shape was closed for `addEventListener`.
    expect(
      containWidgetRenderNames(`base.containWidgetRender("Lit", () => el);`, "planted.ts")
    ).toEqual(["Lit"]);
    expect(
      containWidgetRenderNames(`m["containWidgetRender"]("Lit", () => el);`, "planted.ts")
    ).toEqual(["Lit"]);
    // …and a non-literal name still throws through those spellings, or the
    // widening above would have opened a new silent skip of its own.
    expect(() =>
      containWidgetRenderNames(`base.containWidgetRender(NAME, () => el);`, "planted.ts")
    ).toThrow(/must be a string literal/);
    // An ALIAS renames the callee out of a by-name walk's reach entirely and no
    // syntactic match can follow it, so it is refused rather than skipped.
    expect(() =>
      containWidgetRenderNames(
        `import { containWidgetRender as cwr } from "./widget-base.js";\ncwr("Lit", () => el);`,
        "planted.ts"
      )
    ).toThrow(/imported as 'cwr'/);
    // …but an UNALIASED import of it is the ordinary case and must stay quiet.
    expect(
      containWidgetRenderNames(
        `import { containWidgetRender } from "./widget-base.js";\ncontainWidgetRender("Lit", () => el);`,
        "planted.ts"
      )
    ).toEqual(["Lit"]);
    // Not a call to it — must not be collected.
    expect(containWidgetRenderNames(`other("Lit", () => el);`, "planted.ts")).toEqual([]);
    expect(containWidgetRenderNames(`base.other("Lit", () => el);`, "planted.ts")).toEqual([]);
  });
});
