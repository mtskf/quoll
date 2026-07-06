import { markdownLanguage } from "@codemirror/lang-markdown";
import { TreeFragment } from "@lezer/common";
import { describe, expect, it } from "vitest";
import {
  createIncrementalLinter,
  diffRange,
  lintMarkdown,
} from "../../src/webview/cm/lint/engine.js";

// The same parser object the engine parses with (markdownLanguage.parser).
const PARSER = markdownLanguage.parser;

// Apply a single-range replacement to a string in the same coordinate space the
// diff/parse use (UTF-16 code units), so the test edits mirror real CM changes.
function replace(text: string, from: number, to: number, insert: string): string {
  return text.slice(0, from) + insert + text.slice(to);
}

// Serialize a Lezer tree's shape as an ordered list of `name:from-to`, so two
// trees can be compared for STRUCTURAL identity (not just diagnostic equality).
function treeShape(tree: ReturnType<typeof PARSER.parse>): string[] {
  const out: string[] = [];
  tree.iterate({ enter: (n) => void out.push(`${n.name}:${n.from}-${n.to}`) });
  return out;
}

// Parse `next` incrementally from `prev` using the REAL exported `diffRange`
// (the only novel logic; TreeFragment + parse are Lezer's own code). Mirrors the
// engine's incremental composition so the parity/bench assertions exercise the
// exact contract the engine relies on.
function parseIncremental(prev: string, next: string): ReturnType<typeof PARSER.parse> {
  const prevTree = PARSER.parse(prev);
  const fragments = TreeFragment.applyChanges(TreeFragment.addTree(prevTree), [
    diffRange(prev, next),
  ]);
  return PARSER.parse(next, fragments);
}

// Collect every Lezer node OBJECT (Tree / TreeBuffer, recursively via `.children`)
// reachable from a tree, by reference identity. Incremental parsing reuses unchanged
// subtrees from the previous tree BY REFERENCE, so a genuine incremental parse shares
// most of its node objects with `prevTree`; a full re-parse builds entirely fresh
// objects and shares (almost) none. This lets a test PROVE reuse deterministically,
// without timing — the one thing tree-shape parity and the timing bound cannot catch
// (both pass trivially if the incremental path silently degenerates to a full parse).
function collectNodeRefs(node: unknown, acc: Set<unknown>): void {
  if (node === null || typeof node !== "object") {
    return;
  }
  acc.add(node);
  const children = (node as { children?: unknown }).children;
  if (Array.isArray(children)) {
    for (const child of children) {
      collectNodeRefs(child, acc);
    }
  }
}

describe("diffRange", () => {
  it("returns an empty range for identical text", () => {
    const r = diffRange("hello", "hello");
    expect(r).toEqual({ fromA: 5, toA: 5, fromB: 5, toB: 5 });
  });

  it("brackets a single-character insertion by common prefix/suffix", () => {
    // "abc" -> "abXc": prefix "ab" (2), suffix "c" (1).
    expect(diffRange("abc", "abXc")).toEqual({ fromA: 2, toA: 2, fromB: 2, toB: 3 });
  });

  it("brackets a deletion", () => {
    // "abXc" -> "abc": prefix "ab" (2), suffix "c" (1).
    expect(diffRange("abXc", "abc")).toEqual({ fromA: 2, toA: 3, fromB: 2, toB: 2 });
  });

  it("does not let the suffix overlap the prefix (full replacement)", () => {
    expect(diffRange("aaaa", "bbbb")).toEqual({ fromA: 0, toA: 4, fromB: 0, toB: 4 });
  });
});

describe("createIncrementalLinter matches full lintMarkdown", () => {
  // A document exercising every rule: heading skip (h1->h3), duplicate heading,
  // trailing spaces, double blanks, a fenced code block (blank lines exempt), and
  // leading frontmatter (excluded from linting).
  const base = [
    "---",
    "title: Doc",
    "author: me",
    "---",
    "# Title  ", // trailing spaces (not a hard break: >2)
    "",
    "### Skip", // heading increment: h1 -> h3
    "",
    "",
    "", // triple blank -> no-multiple-blanks
    "## Title", // (not a dup of "Title": different text)
    "",
    "```js",
    "const x = 1;",
    "",
    "",
    "const y = 2;", // blank lines inside code: exempt
    "```",
    "## Skip", // duplicate heading text "Skip"
    "",
    "trailing here   ", // trailing spaces
  ].join("\n");

  it("is identical for the seed document", () => {
    const inc = createIncrementalLinter();
    expect(inc(base)).toEqual(lintMarkdown(base));
  });

  it("stays identical across a sequence of edits (fresh parse each check)", () => {
    const inc = createIncrementalLinter();
    let doc = base;
    inc(doc); // prime the cache

    const edits: Array<[number, number, string]> = [
      // insert a char inside a paragraph (localized)
      [doc.indexOf("trailing here"), doc.indexOf("trailing here"), "X"],
    ];
    // Apply, then generate follow-up structural edits relative to the mutated doc.
    for (const [from, to, insert] of edits) {
      doc = replace(doc, from, to, insert);
      expect(inc(doc)).toEqual(lintMarkdown(doc));
    }

    // Structural: promote "### Skip" to "#### Skip" (changes increment finding).
    doc = doc.replace("### Skip", "#### Skip");
    expect(inc(doc)).toEqual(lintMarkdown(doc));

    // Edit inside the fenced code block (must not spill into structural rules).
    doc = doc.replace("const x = 1;", "const x = 42;");
    expect(inc(doc)).toEqual(lintMarkdown(doc));

    // Frontmatter toggle OFF (bodyStart shifts to 0): every offset re-frames.
    doc = doc.replace("---\ntitle: Doc\nauthor: me\n---\n", "");
    expect(inc(doc)).toEqual(lintMarkdown(doc));

    // Frontmatter toggle back ON.
    doc = `---\ntitle: Doc\n---\n${doc}`;
    expect(inc(doc)).toEqual(lintMarkdown(doc));
  });

  it("produces a tree structurally identical to a full parse (shape parity)", () => {
    let doc = base.replace("---\ntitle: Doc\nauthor: me\n---\n", ""); // no frontmatter: body === whole
    const edits = ["#### Skip", "const x = 42;", "brand new paragraph here"];
    let prev = doc;
    // Localized edit, structural edit, and an insertion — each must yield a tree
    // whose node shape equals a full parse of the same text.
    doc = doc.replace("### Skip", edits[0]);
    expect(treeShape(parseIncremental(prev, doc))).toEqual(treeShape(PARSER.parse(doc)));
    prev = doc;
    doc = doc.replace("const x = 1;", edits[1]);
    expect(treeShape(parseIncremental(prev, doc))).toEqual(treeShape(PARSER.parse(doc)));
    prev = doc;
    doc = `${doc}\n\n${edits[2]}\n`;
    expect(treeShape(parseIncremental(prev, doc))).toEqual(treeShape(PARSER.parse(doc)));
  });
});

// Approximates scripts/gen-perf-fixtures.mjs prose(): heading + paragraph +
// bullet blocks (self-contained here; the test does not read the gitignored
// perf-fixtures/ dir).
function bigProseDoc(): string {
  const PARA = "The quick brown fox jumps over the lazy dog. ".repeat(4);
  let big = "# Performance fixture\n\n";
  let i = 0;
  while (big.length < 1024 * 1024) {
    big += `## Section ${i}\n\n${PARA}\n\n- item one\n- item two\n\n`;
    i += 1;
  }
  return big;
}

describe("PERF: parse cost on a ~1 MB prose doc", () => {
  // Isolates the PARSE component (the Done-when metric: "no longer costs a
  // full-document parse"), NOT the whole lint pass — the line-scan rules still
  // walk the full body O(n) either way, so timing the whole pass would blur the
  // parse win. Single run, noisy — order of magnitude only; recorded in PERF.md.
  it("incremental parse reuses the previous tree instead of a full re-parse", () => {
    const big = bigProseDoc(); // no frontmatter: body === whole doc
    const at = Math.floor(big.length / 2);
    const edited = replace(big, at, at, "x"); // one-character edit mid-document

    // Build the cached previous tree OUTSIDE the timed region. In production
    // `prevTree` is already cached from the prior pass, so timing its
    // construction would fold a FULL parse of `big` into the "incremental"
    // number and hide the win (this is the exact bug the first re-review caught).
    const prevTree = PARSER.parse(big);

    const t0 = performance.now();
    const fullTree = PARSER.parse(edited);
    const full = performance.now() - t0;

    // Time ONLY the incremental step: fragment adjustment + reparse with reuse.
    const t1 = performance.now();
    const fragments = TreeFragment.applyChanges(TreeFragment.addTree(prevTree), [
      diffRange(big, edited),
    ]);
    const incTree = PARSER.parse(edited, fragments);
    const incMs = performance.now() - t1;

    // Parity at scale: the incremental tree equals a full parse.
    expect(treeShape(incTree)).toEqual(treeShape(fullTree));

    // DETERMINISTIC reuse guard (non-timing) — this is what actually pins the
    // PR's objective. A one-char edit in a 1 MB doc reuses almost every node, so
    // the incremental tree must SHARE the overwhelming majority of its node
    // objects (by reference) with prevTree. A regression that silently degrades
    // to a full parse — e.g. dropping the `fragments` arg, or a `diffRange` bug
    // returning a whole-document range — shares (almost) none, so this fails hard
    // where tree-shape parity (full == full) and the timing bound both pass
    // trivially. A full re-parse (`fullTree`) shares essentially nothing with
    // prevTree, which the lower assertion pins as the negative control.
    const prevRefs = new Set<unknown>();
    collectNodeRefs(prevTree, prevRefs);
    const incRefs = new Set<unknown>();
    collectNodeRefs(incTree, incRefs);
    const fullRefs = new Set<unknown>();
    collectNodeRefs(fullTree, fullRefs);
    const sharedInc = [...incRefs].filter((r) => prevRefs.has(r)).length;
    const sharedFull = [...fullRefs].filter((r) => prevRefs.has(r)).length;
    // Incremental reuses the vast majority of prevTree's nodes...
    expect(sharedInc).toBeGreaterThan(incRefs.size * 0.5);
    // ...whereas an independent full re-parse of the same text reuses almost none
    // (only interned singletons like Tree.empty), proving the guard is not vacuous.
    expect(sharedFull).toBeLessThan(incRefs.size * 0.1);

    // Report for PERF.md (single-run, noisy — order of magnitude only).
    console.log(`[bench] parse @~1MB: full=${full.toFixed(2)}ms incremental=${incMs.toFixed(2)}ms`);
    // Loose timing sanity (the deterministic guard above is the real signal; the
    // logged ratio is the recorded evidence).
    expect(incMs).toBeLessThan(full * 1.5 + 5);
  });
});
