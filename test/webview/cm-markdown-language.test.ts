// @vitest-environment happy-dom
//
// Pins the DIRECTLY-BUILT editor language (quollMarkdownLanguage,
// src/webview/cm/markdown.ts) against the upstream markdown() wrapper it
// replaces. The pre-existing suites do NOT cover the direct build:
// cm-decoration-integration mounts markdown({ base }); cm-fold-delegation
// likewise. These four contracts are what the refactor must preserve:
//   1. markdownLanguage.isActiveAt is true on the built language — proves the
//      reused markdownLanguage.data facet (markdownKeymap's commands early-return
//      without it, since isActiveAt compares the languageDataProp facet identity,
//      not the Language instance).
//   2. markdownKeymap (Enter/Backspace) is wired + active.
//   3. the re-implemented headerIndent folds heading lines byte-identically to
//      upstream markdown({ base }) — a parity oracle across heading fixtures.
//   4. the re-implemented listItemFold folds list items byte-identically to that
//      same upstream oracle — its surviving (non-null) range.
// NOTE: the built-in pasteURLAsLink is deliberately NOT part of this language
// (dropped in markdown.ts); Quoll's own paste-URL-over-selection handler lives in
// src/webview/cm/paste/url-link-paste.ts and is covered by cm-paste-url-link.test.ts.
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { codeFolding, foldable, syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { quollMarkdownLanguage } from "../../src/webview/cm/markdown.js";
import { settledState } from "./helpers/settled-state.js";
import { settledView } from "./helpers/settled-view.js";

const quollLang = quollMarkdownLanguage();
const upstreamLang = markdown({ base: markdownLanguage });

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

function mount(doc: string, anchor: number, selEnd = anchor): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.range(anchor, selEnd),
      extensions: [quollLang],
    }),
  });
  // Settle the parse AND republish the language field's tree snapshot: the keymap
  // commands exercised below (lang-markdown's insertNewlineContinueMarkupCommand and
  // deleteMarkupBackward) read that snapshot via `syntaxTree(state)`, which a bare
  // `ensureSyntaxTree` leaves truncated — see helpers/settled-state.ts. `settledView`
  // is its view-carrying twin: it throws rather than returning a discardable boolean.
  // The thrown message names which non-convergence fired; helpers/settled-view.ts's
  // docblock is the authority on the full set, so this comment does not restate it.
  settledView(view);
  return view;
}

describe("quollMarkdownLanguage reuses markdownLanguage.data (isActiveAt)", () => {
  it("markdownLanguage.isActiveAt is true inside the directly-built language", () => {
    // The load-bearing invariant: building with a FRESH facet would silently
    // disable markdownKeymap. State-only, no view needed.
    const state = EditorState.create({ doc: "hello world", extensions: [quollLang] });
    expect(markdownLanguage.isActiveAt(state, 3, 1)).toBe(true);
  });
});

describe("quollMarkdownLanguage wires the active markdownKeymap", () => {
  it("Enter continues a list marker (insertNewlineContinueMarkup via the keymap)", () => {
    const v = mount("- alpha", "- alpha".length);
    const handled = runScopeHandlers(v, new KeyboardEvent("keydown", { key: "Enter" }), "editor");
    expect(handled).toBe(true);
    expect(v.state.sliceDoc()).toBe("- alpha\n- ");
  });

  it("Backspace after a list marker deletes it (deleteMarkupBackward via the keymap)", () => {
    const v = mount("- alpha", 2); // caret right after "- "
    const handled = runScopeHandlers(
      v,
      new KeyboardEvent("keydown", { key: "Backspace" }),
      "editor"
    );
    expect(handled).toBe(true);
    // Upstream deleteMarkupBackward removes the bullet marker; assert the "- "
    // prefix is gone (exact remainder pinned so a broken keymap reds this).
    expect(v.state.sliceDoc()).toBe("alpha");
  });
});

describe("mount() hands the keymap a settled tree snapshot", () => {
  // Non-vacuity guard for mount()'s `settledView(view)` settle, made deterministic by
  // DOC SIZE instead of CPU load — same construction as cm-fold-blockquote.test.ts's
  // "reads a settled parse" describe, which documents why an over-long doc always
  // lands a truncated snapshot. Replace mount()'s `settledView(view)` with a bare
  // `ensureSyntaxTree(view.state, view.state.doc.length)` — which advances the parse
  // CONTEXT but never republishes the field snapshot — and the second assertion goes red.
  const doc = `${"filler paragraph line\n\n".repeat(200)}- alpha`;

  it("a freshly-created state's snapshot is truncated (the precondition)", () => {
    // If an upstream change ever made the init snapshot complete, the guard below
    // would be vacuous — so it reds here instead of silently passing.
    const state = EditorState.create({ doc, extensions: [quollLang] });
    expect(syntaxTree(state).length).toBeLessThan(state.doc.length);
  });

  it("the mounted view's snapshot spans the whole doc", () => {
    const v = mount(doc, doc.length);
    expect(syntaxTree(v.state).length).toBe(v.state.doc.length);
  });
});

describe("re-implemented headerIndent folds byte-identically to upstream", () => {
  // The parity oracle for the section-boundary math. Compare foldable() on the
  // HEADING line only (quollLang's nonFoldableBlocks subtraction diverges from
  // upstream on blockquote/paragraph/code lines by design — headings are the
  // shared contract). A wrong sectionEnd/headingLevel diverges from upstream.
  // The blockquote-wrapped-heading fixture pins the exact from/to that
  // cm-fold-blockquote.test.ts only asserts `not.toBeNull()` for.
  // Settled, not merely ensureSyntaxTree'd: `foldable()` resolves in the language
  // field's tree snapshot, which a bare `ensureSyntaxTree` leaves truncated — the
  // load-sensitive spurious `null`. See helpers/settled-state.ts.
  function foldHeadingRange(lang: Extension, doc: string, headAt: number) {
    const state = settledState(EditorState.create({ doc, extensions: [lang, codeFolding()] }));
    const line = state.doc.lineAt(headAt);
    return foldable(state, line.from, line.to);
  }

  const FIXTURES: Array<{ doc: string; headAt: number }> = [
    { doc: "# A\nbody1\nbody2\n# B\n", headAt: 0 }, // simple section
    { doc: "# A\n## A1\ntext\n# B\n", headAt: 0 }, // spans lower subheading
    { doc: "## H2 only\nbody\nmore\n", headAt: 0 }, // trailing section to EOF
    { doc: "Setext\n===\n\nbody\ntail\n", headAt: 0 }, // setext H1
    { doc: "# top\nintro\n### deep\nx\ny\n# end\n", headAt: 0 }, // top spans H3
    { doc: "> # A\n> body\n> # B\n", headAt: 0 }, // heading INSIDE a blockquote
    { doc: "# A\nbody\n# B\nafter\n", headAt: "# A\nbody\n".length }, // mid-doc heading (headAt > 0): "# B" folds to EOF
  ];

  for (const { doc, headAt } of FIXTURES) {
    it(`matches upstream fold range for ${JSON.stringify(doc.slice(0, 14))}…`, () => {
      const q = foldHeadingRange(quollLang, doc, headAt);
      const u = foldHeadingRange(upstreamLang, doc, headAt);
      expect(q).not.toBeNull(); // headings must stay foldable...
      expect(q).toEqual(u); // ...with byte-identical from/to to upstream.
    });
  }

  // Boundary + break-guard coverage the FIXTURES loop (all non-empty sections)
  // cannot reach — asserted as parity-on-null (both quoll and upstream return
  // null): an EMPTY section returns null (sectionEnd === end, so `upto > end` is
  // false — this kills a `>=` mutant of that comparison), and a body line PAST
  // line 0 returns null via the `node.from < start` parent-walk break guard.
  // Quoll-SPECIFIC divergence (NOT a parity oracle): a lone `-`/`=` setext
  // underline reads as a nascent bullet list, so quollLang suppresses its fold
  // chevron via the shared isNascentLoneSetextHeading predicate — while upstream,
  // which has no such notion, still folds it as a heading.
  it("suppresses the fold chevron for a nascent lone `-`/`=` setext (diverges from upstream)", () => {
    for (const underline of ["-", "="]) {
      const doc = `intro\n\nFoo\n${underline}\n\nbody\n`;
      const fooAt = doc.indexOf("Foo");
      expect(foldHeadingRange(quollLang, doc, fooAt)).toBeNull(); // no chevron in Quoll
      expect(foldHeadingRange(upstreamLang, doc, fooAt)).not.toBeNull(); // upstream still folds it
    }
  });

  it("KEEPS the fold chevron for a real multi-char setext heading (no regression)", () => {
    // Two-or-more `-`/`=` read as an intentional heading → chevron stays, parity
    // with upstream.
    const doc = "intro\n\nFoo\n---\n\nbody\n";
    const fooAt = doc.indexOf("Foo");
    const q = foldHeadingRange(quollLang, doc, fooAt);
    expect(q).not.toBeNull();
    expect(q).toEqual(foldHeadingRange(upstreamLang, doc, fooAt));
  });

  it("suppresses the chevron for a lone `-`/`=` with a trailing space, but KEEPS it for a real `--`/`==` (boundary pair)", () => {
    // The two lengths immediately astride the nascent/real boundary. A lone marker
    // with a mid-typing trailing space (`Foo\n- `) is STILL nascent — the
    // HeaderMark excludes the trailing space, so the mark stays length 1 → no
    // chevron in Quoll (upstream still folds it). Exactly two markers (`Foo\n--`)
    // is the first length that reads as a real heading → chevron stays, byte-
    // identical to upstream. Revert-check: relaxing `mark.to - mark.from === 1`
    // to `=== 2` reds the trailing-space null; relaxing to `>= 1` reds the two-char
    // parity (quollLang would then return null while upstream folds). The length
    // gate is char-agnostic, so `=` (SetextHeading1) behaves identically to `-`.
    for (const u of ["-", "="]) {
      const trailing = `intro\n\nFoo\n${u} `;
      const trailingAt = trailing.indexOf("Foo");
      expect(foldHeadingRange(quollLang, trailing, trailingAt)).toBeNull();
      expect(foldHeadingRange(upstreamLang, trailing, trailingAt)).not.toBeNull();

      const twoChar = `intro\n\nFoo\n${u}${u}`;
      const twoCharAt = twoChar.indexOf("Foo");
      const q = foldHeadingRange(quollLang, twoChar, twoCharAt);
      expect(q).not.toBeNull();
      expect(q).toEqual(foldHeadingRange(upstreamLang, twoChar, twoCharAt));
    }
  });

  it("a nascent lone setext mid-section is walked PAST, not treated as a same-level boundary (regression guard, diverges from upstream)", () => {
    // A nascent lone `-` sits between a level-2 `## A` section and a level-1 `# B`.
    // The nascent underline is Lezer-parsed as a SetextHeading2 (level 2). Because
    // headingLevel() returns null for it (via isNascentLoneSetextHeading), sectionEnd
    // walks PAST it as non-boundary content and `## A` folds all the way to the line
    // before `# B`. The level-2 host section is deliberate: it makes the fixture
    // sensitive to the nascent guard itself. Revert-check: removing the
    // isNascentLoneSetextHeading guard makes the `-` a real SetextHeading2 (level
    // 2 <= 2) → an IMMEDIATE same-level boundary → `## A`'s section is empty →
    // foldHeadingRange returns null → this test reds. That is exactly why UPSTREAM,
    // which has no nascent notion, returns null here (asserted below as the
    // divergence). The sectionEnd `<=` boundary operator is pinned separately by the
    // FIXTURES parity loop + the empty-section/post-heading test above.
    // Observed via probe: quoll q = {from:4,to:20}; to === doc.indexOf("# B") - 1 (20).
    const doc = "## A\nbody\nFoo\n-\nmore\n# B\nend\n";
    const q = foldHeadingRange(quollLang, doc, 0);
    expect(q).not.toBeNull();
    expect(q?.to).toBe(doc.indexOf("# B") - 1);
    // Upstream folds the nascent `-` as a real level-2 heading → `## A` empty → null.
    expect(foldHeadingRange(upstreamLang, doc, 0)).toBeNull();
  });

  it("empty-section and post-heading body lines fold to null, matching upstream", () => {
    const empty = "# A\n# B\n"; // sectionEnd(A) === A.to === end → no fold
    expect(foldHeadingRange(quollLang, empty, 0)).toBeNull();
    expect(foldHeadingRange(upstreamLang, empty, 0)).toBeNull();
    const body = "# A\nbody\n";
    const bodyAt = body.indexOf("body"); // headAt > 0 → exercises `node.from < start`
    expect(foldHeadingRange(quollLang, body, bodyAt)).toBeNull();
    expect(foldHeadingRange(upstreamLang, body, bodyAt)).toBeNull();
  });
});

describe("re-implemented listItemFold folds list items byte-identically to upstream", () => {
  // The parity oracle for listItemFold's SURVIVING range (cm/markdown.ts) — the arm
  // cm-fold-blockquote.test.ts leaves uncompared, since it asserts only null /
  // not-null. Same construction as the headerIndent oracle above: settled state,
  // foldable() on the first line, byte-identical from/to against upstream.
  function foldListRange(lang: Extension, doc: string) {
    const state = settledState(EditorState.create({ doc, extensions: [lang, codeFolding()] }));
    const line = state.doc.line(1);
    return foldable(state, line.from, line.to);
  }

  const FIXTURES = [
    "- a\n  - b\n  - c\n- d\n", // nested children
    "- item line one\n  item line two\n  item line three\n- next\n", // indented continuation lines
    "- lazy one\nlazy two\n- next\n", // lazy continuation line (no indent)
    "1. one\n   cont\n2. two\n", // ordered marker
  ];

  for (const doc of FIXTURES) {
    it(`matches upstream fold range for ${JSON.stringify(doc.slice(0, 14))}…`, () => {
      const q = foldListRange(quollLang, doc);
      expect(q).not.toBeNull(); // list items must stay foldable...
      expect(q).toEqual(foldListRange(upstreamLang, doc)); // ...with upstream's from/to.
    });
  }
});

describe("quollMarkdownLanguage registers the ==highlight== inline mark", () => {
  it("parses ==text== into a Highlight span (registered in the webview config)", () => {
    const state = EditorState.create({ doc: "==hi==", extensions: [quollLang] });
    const names: string[] = [];
    syntaxTree(state).iterate({
      enter: (n) => {
        names.push(n.name);
      },
    });
    expect(names).toContain("Highlight");
    expect(names).toContain("HighlightMark");
  });
});
