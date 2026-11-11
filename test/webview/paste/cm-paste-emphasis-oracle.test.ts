// @vitest-environment happy-dom
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { htmlToMarkdown } from "../../../src/webview/cm/paste/html-to-markdown.js";
import { assertStyleParity } from "./inline-style-oracle.js";

describe("oracle self-tests", () => {
  const accept = (html: string, md: string) => () => {
    expect(() => assertStyleParity(html, md)).not.toThrow();
  };
  const reject = (html: string, md: string) => () => {
    expect(() => assertStyleParity(html, md)).toThrow(/style parity/);
  };

  it("accepts the period kept inside both runs", accept("<b>a<i>a.</i>a</b>", "**a*a*.a**"));
  it(
    "rejects a dropped bold when bold spans both neighbours",
    reject("<b>a<i>a.</i>a</b>", "**a*a***.**a**")
  );
  it(
    "accepts a drop forced by an enclosing run closing (clause ii)",
    accept("<b>a<i>a</i></b><i>(a)</i>", "**a*a***(*a)*")
  );
  it(
    "accepts a drop next to an unstyled word (clause i)",
    accept("<i>a<b>a.</b>a</i>", "*a**a**.a*")
  );
  it(
    "rejects a dropped italic when italic spans both neighbours",
    reject("<i>a<b>a.</b>a</i>", "*a**a***.*a*")
  );
  it("rejects a drop at a string edge", reject("<b>a.</b>", "**a**."));
  it("accepts a drop before an unstyled word", accept("<b>a.</b>b", "**a**.b"));
  it("trims whitespace at the HTML edge", accept("<b>a </b>", "**a**"));
  it("trims the heading separator on the Markdown side", accept("<h1>t #</h1>", "# t \\#"));
  it("collapses whitespace per text node", accept("a  <b>  b</b>", "a  **b**"));
});

function roundTrip(html: string): void {
  const result = htmlToMarkdown(html);
  if (result === null) {
    throw new Error(`conversion returned null for ${JSON.stringify(html)}`);
  }
  try {
    assertStyleParity(html, result.markdown);
  } catch (err) {
    throw new Error(
      `${JSON.stringify(html)} -> ${JSON.stringify(result.markdown)}\n${String(err)}`
    );
  }
}

const STYLES = [
  (x: string) => x,
  (x: string) => `<b>${x}</b>`,
  (x: string) => `<i>${x}</i>`,
  (x: string) => `<b><i>${x}</i></b>`,
];

/** Every sequence of 1..maxRuns runs, each a (style, text) pair. */
function corpus(texts: readonly string[], maxRuns: number): string[] {
  const runs = STYLES.flatMap((wrap) => texts.map((text) => wrap(text)));
  let level = [""];
  const all: string[] = [];
  for (let n = 1; n <= maxRuns; n++) {
    level = level.flatMap((prefix) => runs.map((run) => prefix + run));
    all.push(...level);
  }
  return all;
}

// happy-dom 21 keeps every document `DOMParser.parseFromString` creates reachable
// from its window (about 20 KB each), so ~260k parses in the environment's one
// window run the worker out of heap. Each batch parses in a throwaway window
// instead; the converter and the oracle both read the global `DOMParser`, and
// neither relies on `instanceof` against the environment's classes.
const BATCH = 2000;

// The whole corpus (130,196 cases) passed once in about 12 s; A and B are sampled
// to keep the file near 5 s. An odd stride is coprime with the 16- and 8-way
// last run, which varies fastest, so every last-run choice is still exercised.
const SAMPLE_STRIDE = 3;

async function inFreshWindow(body: () => void): Promise<void> {
  const win = new Window();
  vi.stubGlobal("DOMParser", win.DOMParser);
  try {
    body();
  } finally {
    vi.unstubAllGlobals();
    await win.happyDOM.close();
  }
}

describe("emphasis round-trip against the Lezer re-parse", () => {
  it.each([
    ["adjacent strong", "<b>A</b><b>B</b>"],
    ["adjacent emphasis (old *A**B*)", "<i>A</i><i>B</i>"],
    ["nested strong (old **A**B****)", "<b>A<b>B</b></b>"],
    ["Word span inside strong", "<b>A<span>B</span></b>"],
    ["3-element counterexample", "<strong><em>A</em></strong><em>B</em><strong>C</strong>"],
    ["Note:", "<b>Note:</b>text"],
    ["parenthesised run", "x<b>(a)</b>b"],
    ["CJK brackets", "これは<b>「重要」</b>です"],
    ["heading trailing hash", "<h1>title #</h1>"],
    ["heading of a lone hash", "<h2>#</h2>"],
    ["code span closer before a word", "<b><code>x</code></b>y"],
  ])("%s", (_name, html) => {
    roundTrip(html);
  });

  it.each([
    ["A", ["a", ".", "(a)", "a."], 4, 69_904, SAMPLE_STRIDE],
    ["B", ["a", "."], 5, 37_448, SAMPLE_STRIDE],
    ["C", ["a", "。", "「a」", "a。", "😀", "a😀"], 3, 14_424, 1],
    ["D", ["a", "a ", " a", ".", ": "], 3, 8_420, 1],
  ] as const)(
    "corpus %s",
    async (_name, texts, maxRuns, count, stride) => {
      const cases = corpus(texts, maxRuns);
      expect(cases).toHaveLength(count);
      const sampled = cases.filter((_html, i) => i % stride === 0);
      for (let i = 0; i < sampled.length; i += BATCH) {
        await inFreshWindow(() => {
          for (const html of sampled.slice(i, i + BATCH)) {
            roundTrip(html);
          }
        });
      }
    },
    30_000
  );
});
