import { TreeFragment } from "@lezer/common";
import { describe, expect, it, vi } from "vitest";
import {
  createIncrementalUnsafeUrlFinder,
  diffRange,
  findUnsafeUrl,
  parseMarkdown,
} from "../../src/markdown/lezer-url-walker.js";
import {
  createIncrementalWriteValidator,
  validateMarkdownForWrite,
} from "../../src/markdown/validate-for-write.js";

describe("diffRange", () => {
  it("returns an empty range for identical text", () => {
    expect(diffRange("hello", "hello")).toEqual({ fromA: 5, toA: 5, fromB: 5, toB: 5 });
  });

  it("brackets a single-character insertion by common prefix/suffix", () => {
    expect(diffRange("abc", "abXc")).toEqual({ fromA: 2, toA: 2, fromB: 2, toB: 3 });
  });

  it("brackets a deletion", () => {
    expect(diffRange("abXc", "abc")).toEqual({ fromA: 2, toA: 3, fromB: 2, toB: 2 });
  });

  it("does not let the suffix overlap the prefix (full replacement)", () => {
    expect(diffRange("aaaa", "bbbb")).toEqual({ fromA: 0, toA: 4, fromB: 0, toB: 4 });
  });
});

describe("createIncrementalUnsafeUrlFinder matches findUnsafeUrl", () => {
  const base = [
    "---",
    "title: Doc",
    "---",
    "# Heading",
    "",
    "A [safe link](https://example.com) and text.",
    "",
    "![img](./local.png)",
    "",
    "<https://example.org/autolink>",
    "",
    "[ref]: https://ref.example.com",
  ].join("\n");

  it("is identical for the seed document", () => {
    const inc = createIncrementalUnsafeUrlFinder();
    expect(inc(base)).toEqual(findUnsafeUrl(base));
  });

  it("stays identical across an edit sequence, including URL-safety toggles", () => {
    const inc = createIncrementalUnsafeUrlFinder();
    let doc = base;
    inc(doc); // prime the cache

    // Localized safe edit.
    doc = doc.replace("and text.", "and MORE text.");
    expect(inc(doc)).toEqual(findUnsafeUrl(doc));

    // Introduce an UNSAFE url mid-document — incremental must catch it.
    doc = doc.replace("https://example.com", "javascript:alert(1)");
    expect(inc(doc)).toEqual(findUnsafeUrl(doc));
    expect(inc(doc)?.code).toBe("unsafe_url");

    // Repair it back to safe.
    doc = doc.replace("javascript:alert(1)", "https://ok.example.com");
    expect(inc(doc)).toEqual(findUnsafeUrl(doc));
    expect(inc(doc)).toBeNull();

    // Frontmatter toggle OFF then ON (offsets re-frame wholesale).
    doc = doc.replace("---\ntitle: Doc\n---\n", "");
    expect(inc(doc)).toEqual(findUnsafeUrl(doc));
    doc = `---\ntitle: Doc\n---\n${doc}`;
    expect(inc(doc)).toEqual(findUnsafeUrl(doc));
  });

  it("falls back to a fresh parse when the incremental path throws (fail-closed)", () => {
    // Inject a parse that throws ONLY on the incremental (fragments-present)
    // call and works on a fresh call — proving the catch degrades to a full
    // parse rather than propagating, and still returns the correct verdict.
    let incrementalCalls = 0;
    let freshCalls = 0;
    const flakyParse = (
      content: string,
      fragments?: readonly unknown[]
    ): ReturnType<typeof parseMarkdown> => {
      if (fragments) {
        incrementalCalls += 1;
        throw new Error("boom: incremental parse failed");
      }
      freshCalls += 1;
      return parseMarkdown(content);
    };
    // Silence + observe the expected fallback log (the catch console.error).
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const inc = createIncrementalUnsafeUrlFinder(flakyParse as never);

    const safe = "[ok](https://example.com)";
    const unsafe = "[bad](javascript:alert(1))";

    expect(inc(safe)).toBeNull(); // primes cache via the fresh path (no fragments)
    // Next call takes the incremental branch → throws → falls back to fresh.
    const verdict = inc(unsafe);
    expect(verdict).toEqual(findUnsafeUrl(unsafe));
    expect(verdict?.code).toBe("unsafe_url");
    expect(incrementalCalls).toBe(1); // the incremental attempt was made...
    expect(freshCalls).toBe(2); // ...and both calls ultimately parsed fresh
    expect(errSpy).toHaveBeenCalledTimes(1); // the fallback logged (observability)
    errSpy.mockRestore();
  });
});

// Serialize a tree's STRUCTURE (not just its preorder node list) with enter +
// leave markers, so nesting/parent-child differences are detected — the walker
// gates a URL child UNDER a Link/Image, so depth matters. A bare preorder of
// `name:from-to` could collide for two differently-nested trees; the balanced
// enter (`+`) / leave (`-`) bracketing encodes the full shape.
function treeShape(tree: ReturnType<typeof parseMarkdown>): string[] {
  const out: string[] = [];
  tree.iterate({
    enter: (n) => void out.push(`+${n.name}:${n.from}-${n.to}`),
    leave: (n) => void out.push(`-${n.name}`),
  });
  return out;
}

// Every Lezer node OBJECT reachable by reference — incremental parsing reuses
// unchanged subtrees BY REFERENCE, so a genuine incremental parse shares most
// node objects with prevTree; a full re-parse shares (almost) none. Proves
// reuse deterministically without timing — the one thing shape-parity and a
// timing bound cannot catch (both pass trivially if incremental silently
// degrades to a full parse).
function collectNodeRefs(node: unknown, acc: Set<unknown>): void {
  if (node === null || typeof node !== "object") return;
  acc.add(node);
  const children = (node as { children?: unknown }).children;
  if (Array.isArray(children)) for (const c of children) collectNodeRefs(c, acc);
}

// Parse `next` incrementally from `prev` using the REAL exported parseMarkdown +
// diffRange (the only novel logic; TreeFragment + parse are Lezer's own code).
function parseIncremental(prev: string, next: string): ReturnType<typeof parseMarkdown> {
  const prevTree = parseMarkdown(prev);
  const fragments = TreeFragment.applyChanges(TreeFragment.addTree(prevTree), [
    diffRange(prev, next),
  ]);
  return parseMarkdown(next, fragments);
}

describe("incremental parse is genuinely incremental (non-vacuity)", () => {
  it("produces a tree structurally identical to a full parse (incl. nesting)", () => {
    let doc = "# Doc\n\n[a](https://example.com) and ![i](./p.png)\n\npara two here\n";
    let prev = doc;
    doc = doc.replace("para two here", "para two EDITED here"); // localized
    expect(treeShape(parseIncremental(prev, doc))).toEqual(treeShape(parseMarkdown(doc)));
    prev = doc;
    doc = doc.replace("https://example.com", "https://example.com/deep/path"); // inside a Link's URL child
    expect(treeShape(parseIncremental(prev, doc))).toEqual(treeShape(parseMarkdown(doc)));
    prev = doc;
    doc = `${doc}\n\n## New section\n\n[ref]: https://ref.test\n`; // structural append
    expect(treeShape(parseIncremental(prev, doc))).toEqual(treeShape(parseMarkdown(doc)));
  });

  it("reuses the previous tree's node objects (reference-sharing, non-timing)", () => {
    const prev = "# Heading\n\nA paragraph with a [link](https://example.com) and more.\n".repeat(
      200
    );
    const at = Math.floor(prev.length / 2);
    const next = prev.slice(0, at) + "x" + prev.slice(at); // one-char mid-doc edit

    const prevTree = parseMarkdown(prev);
    const fragments = TreeFragment.applyChanges(TreeFragment.addTree(prevTree), [
      diffRange(prev, next),
    ]);
    const incTree = parseMarkdown(next, fragments);
    const fullTree = parseMarkdown(next);

    expect(treeShape(incTree)).toEqual(treeShape(fullTree)); // parity

    const prevRefs = new Set<unknown>();
    collectNodeRefs(prevTree, prevRefs);
    const incRefs = new Set<unknown>();
    collectNodeRefs(incTree, incRefs);
    const fullRefs = new Set<unknown>();
    collectNodeRefs(fullTree, fullRefs);
    const sharedInc = [...incRefs].filter((r) => prevRefs.has(r)).length;
    const sharedFull = [...fullRefs].filter((r) => prevRefs.has(r)).length;
    expect(sharedInc).toBeGreaterThan(incRefs.size * 0.5); // incremental reuses the majority...
    expect(sharedFull).toBeLessThan(incRefs.size * 0.1); // ...full re-parse reuses ~none (negative control)
  });
});

describe("createIncrementalWriteValidator matches validateMarkdownForWrite", () => {
  it("agrees on a scripted edit sequence (safe/unsafe/frontmatter transitions)", () => {
    const inc = createIncrementalWriteValidator();
    let doc = "# Title\n\n[a](https://example.com)\n";
    const steps = [
      (d: string) => d.replace("Title", "Title Two"),
      (d: string) => d.replace("https://example.com", "javascript:alert(1)"), // → unsafe
      (d: string) => d.replace("javascript:alert(1)", "https://ok.test"), // → safe
      (d: string) => `---\ntitle: x\n---\n${d}`, // add valid frontmatter
      (d: string) => d.replace("title: x", "title: x\nbad: ---"), // still valid frontmatter body? verify vs fresh
      (d: string) => d.replace("---\ntitle: x\nbad: ---\n---\n", ""), // strip frontmatter
    ];
    expect(inc(doc)).toEqual(validateMarkdownForWrite(doc)); // seed
    for (const step of steps) {
      doc = step(doc);
      expect(inc(doc)).toEqual(validateMarkdownForWrite(doc));
    }
  });

  // ---- Property / fuzz battery: MANDATORY security gate ----
  // A deterministic PRNG (seeded, reproducible in CI — no flake) drives a long
  // sequence of random single-range edits over an evolving document, splicing
  // in "interesting" fragments (safe/unsafe URLs, frontmatter fences, bare
  // `---`, brackets, backslash + entity escapes). At EVERY step the incremental
  // validator's verdict must equal a fresh validator's verdict. This is the
  // pinning of Lezer's incremental ≡ fresh invariant the write-gate rests on.
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Corpus chosen to exercise the Markdown-structure boundaries where an
  // incremental parse is MOST likely to diverge from a fresh one if the diff
  // range or fragment reuse were wrong: URL safety toggles, frontmatter fences,
  // bare `---`, CRLF line endings, astral/surrogate codepoints (diffRange is
  // UTF-16 code-unit based), link titles, nested brackets/parens, duplicate
  // reference definitions, raw-HTML blocks, and fenced-code boundaries.
  const FRAGMENTS = [
    "[safe](https://example.com)",
    "[bad](javascript:alert(1))",
    "![i](./a.png)",
    "<https://x.test>",
    "[danger](vbscript:foo)",
    "[ref]: data:text/html,evil",
    "[ref]: https://second.example.com", // duplicate reference definition (both hit disk → both gated)
    '[titled](https://t.test "a title")', // link title
    "[nested [inner]](https://n.test)", // nested brackets
    "[parens](https://p.test/(a)/b)", // parens in destination
    "\n---\ntitle: t\n---\n",
    "\n---\n", // bare thematic break / frontmatter-fence lookalike
    "line one\r\nline two\r\n", // CRLF — must not bisect a pair wrongly
    "emoji 😀 and 𝟙 astral", // astral / surrogate pairs (UTF-16 code units)
    '<div data-x="javascript:alert(1)">raw</div>', // raw HTML — opaque, NOT gated
    "\n```js\nvar u = 'javascript:x';\n```\n", // fenced code — opaque body
    "normal words ",
    "# heading\n",
    "\\[escaped\\]",
    "&#106;avascript:", // entity-encoded 'j' — decoder torture
    "> quote\n",
    "\n\n",
    "`code`",
    "](http://",
  ];

  it("agrees with a fresh validator over a seeded random edit battery", () => {
    const rnd = mulberry32(0x9e3779b9);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
    const inc = createIncrementalWriteValidator();

    let doc = "# Start\r\n\r\nsome text with a [link](https://example.com).\n";
    inc(doc); // prime

    for (let i = 0; i < 500; i += 1) {
      // Bias ~20% of edits to the document boundaries (start / end), where
      // incremental prefix/suffix reuse is most fragile.
      const r = rnd();
      const from = r < 0.1 ? 0 : r < 0.2 ? doc.length : Math.floor(rnd() * (doc.length + 1));
      const to = Math.min(doc.length, from + Math.floor(rnd() * 12));
      // ~30% deletions (empty insert), else splice an interesting fragment.
      const insert = rnd() < 0.3 ? "" : pick(FRAGMENTS);
      doc = doc.slice(0, from) + insert + doc.slice(to);
      const incVerdict = inc(doc);
      const freshVerdict = validateMarkdownForWrite(doc);
      // Compare on the whole result object so ok, code, AND message all match.
      // On divergence the seed + iteration `i` reproduce it deterministically.
      expect(incVerdict, `divergence at iteration ${i}`).toEqual(freshVerdict);
    }
  });
});
