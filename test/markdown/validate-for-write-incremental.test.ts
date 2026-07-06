import { TreeFragment } from "@lezer/common";
import { describe, expect, it, vi } from "vitest";
import {
  createIncrementalUnsafeUrlFinder,
  diffRange,
  findUnsafeUrl,
  parseMarkdown,
} from "../../src/markdown/lezer-url-walker.js";

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
  const fragments = TreeFragment.applyChanges(TreeFragment.addTree(prevTree), [diffRange(prev, next)]);
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
    const prev = "# Heading\n\nA paragraph with a [link](https://example.com) and more.\n".repeat(200);
    const at = Math.floor(prev.length / 2);
    const next = prev.slice(0, at) + "x" + prev.slice(at); // one-char mid-doc edit

    const prevTree = parseMarkdown(prev);
    const fragments = TreeFragment.applyChanges(TreeFragment.addTree(prevTree), [diffRange(prev, next)]);
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
