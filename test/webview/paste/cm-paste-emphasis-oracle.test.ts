// @vitest-environment happy-dom
import { Parser } from "commonmark";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { htmlToMarkdown } from "../../../src/webview/cm/paste/html-to-markdown.js";
import {
  assertStyleParity,
  commonmarkStyledChars,
  markdownStyledChars,
} from "./inline-style-oracle.js";

it("CommonMark module exposes a usable Parser", () => {
  const doc = new Parser().parse("**hello**");
  expect(doc.type).toBe("document");
  expect(doc.firstChild?.type).toBe("paragraph");
  expect(doc.firstChild?.firstChild?.type).toBe("strong");
  expect(doc.firstChild?.firstChild?.firstChild?.literal).toBe("hello");
});

it("CommonMark AST reader preserves emphasis code links entities and breaks", () => {
  expect(commonmarkStyledChars("# **a** *b* \\* &#97; `x` [z](url)")).toEqual(
    [..."a b * a x z"].map((ch, i) => ({ ch, style: i === 0 ? 1 : i === 2 ? 2 : 0 }))
  );
  expect(commonmarkStyledChars("a  \nb\nc")).toEqual([..."ab\nc"].map((ch) => ({ ch, style: 0 })));
});

it("both readers normalize padded code spans", () => {
  for (const read of [commonmarkStyledChars, markdownStyledChars]) {
    expect(read("`` `x` ``")).toEqual([..."`x`"].map((ch) => ({ ch, style: 0 })));
    expect(read("**`` `x` ``**")).toEqual([..."`x`"].map((ch) => ({ ch, style: 1 })));
    expect(read("a`   `b")).toEqual([..."a   b"].map((ch) => ({ ch, style: 0 })));
  }
});

it("CommonMark oracle rejects the three Lezer-only layouts", () => {
  for (const [html, md] of [
    ["<b>a<i>b</i></b><i>c</i>", "**a*b****c*"],
    ["<i>a<b>b</b></i><b>c</b>", "*a**b*****c**"],
    ["<b><i>a</i>a<i>a</i></b>", "***a*a*a***"],
  ]) {
    expect(() => assertStyleParity(html, md)).toThrow(/CommonMark/);
  }
});

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

  // One self-test per remaining fail() branch, each pinned to its own message so a
  // branch that stops firing (or fires as another) turns its test red.
  it("rejects differing text", () => {
    expect(() => assertStyleParity("<b>a</b>", "**b**")).toThrow(/text differs/);
  });
  it("rejects a restyled word", () => {
    expect(() => assertStyleParity("<b>a</b>", "a")).toThrow(/word char 0 restyled/);
  });
  it("rejects a word that gained a style", () => {
    expect(() => assertStyleParity("a", "**a**")).toThrow(/word char 0 restyled/);
  });
  it("rejects a space that gained a style", () => {
    expect(() => assertStyleParity("<b>a</b> <b>b</b>", "**a b**")).toThrow(
      /space 1 gained a style/
    );
  });
  it("rejects punctuation that gained a style", () => {
    expect(() => assertStyleParity("<b>a</b>.<b>b</b>", "**a.b**")).toThrow(
      /punctuation 1 gained a style/
    );
  });
  it("names the style on a lost-style punctuation", () => {
    expect(() => assertStyleParity("<b>a.</b>", "**a**.")).toThrow(
      /punctuation 1 lost style \d+ without a forced demotion/
    );
  });
});

it.each([
  ["<b>a<i>b</i></b><i>c</i>", "**a**&#8288;***b***&#8288;*c*"],
  ["<i>a<b>b</b></i><b>c</b>", "*a*&#8288;***b***&#8288;**c**"],
  ["<b><i>a</i>a<i>a</i></b>", "***a***&#8288;**a**&#8288;***a***"],
  ["<b>This is <i>important</i> text</b>", "**This is** ***important*** **text**"],
  ["<b>a <i>b</i> c</b>", "**a** ***b*** **c**"],
  ["<b>a <i>b:</i> c</b>", "**a** ***b:*** **c**"],
  ["<b><i>a</i> a <i>a</i></b>", "***a*** **a** ***a***"],
])("balances every equal-style region: %s", (html, expected) => {
  assertStyleParity(html, expected);
  expect(htmlToMarkdown(html)?.markdown).toBe(expected);
});

it.each([
  ["<b>a<i>b</i></b><i>c</i>", "**a**&#8288;***b***&#8288;*c*"],
  ["<i>a<b>b</b></i><b>c</b>", "*a*&#8288;***b***&#8288;**c**"],
  ["<b><i>a</i>a<i>a</i></b>", "***a***&#8288;**a**&#8288;***a***"],
  ["<b>a <i>b</i> c</b>", "**a** ***b*** **c**"],
])("serializes balanced link labels independently of outer regions: %s", (label, expected) => {
  const html = `<a href="u">${label}</a>`;
  const markdown = htmlToMarkdown(html)?.markdown;
  expect(markdown).toBe(`[${expected}](u)`);
  assertStyleParity(html, markdown as string);
});

it.each([
  "a<b>😀</b>",
  "<b>😀</b>a",
  "<b>a😀</b>x",
  "<b><code>x</code></b>😀",
  '<a href="u">a<b>😀</b></a>',
])("preserves astral word styles under both pinned parsers: %s", (html) => {
  const markdown = htmlToMarkdown(html)?.markdown;
  expect(markdown).toBeDefined();
  assertStyleParity(html, markdown as string);
});

it.each([
  "\u00a0",
  "\u2028",
  "\u2029",
  "\ufeff",
])("Unicode whitespace agrees in both readers: %s", (space) => {
  const source = `a${space}**b**`;
  const expected = [
    { ch: "a", style: 0 },
    ...(space === "\ufeff" ? [] : [{ ch: space, style: 0 }]),
    { ch: "b", style: 1 },
  ];
  expect(commonmarkStyledChars(source)).toEqual(expected);
  expect(markdownStyledChars(source)).toEqual(expected);
  const html = `a${space}<b>b</b>`;
  const converted = htmlToMarkdown(html)?.markdown as string;
  assertStyleParity(html, converted);
});

it.each([
  "<code>&amp;#8288;</code>",
  "<b>a</b><i><code>x</code></i>",
  "<code>`x`</code>",
  "<b><code>`x`</code></b>",
])("code and reference text survive conversion: %s", (html) => {
  const markdown = htmlToMarkdown(html)?.markdown;
  expect(markdown).toBeDefined();
  assertStyleParity(html, markdown as string);
});

it.each([
  "<h1><b>a<i>b</i></b> #</h1>",
  "<h1>a<br>b</h1>",
  '<a href="u">a<br>b</a>',
  "<p>a<br>b</p>",
  "a &amp; b",
  "&amp;#8288;",
])("heading break ampersand reference interactions: %s", (html) => {
  const markdown = htmlToMarkdown(html)?.markdown;
  expect(markdown).toBeDefined();
  if (!html.includes("<br>")) {
    assertStyleParity(html, markdown as string);
  }
});

it("heading break ampersand and reference bytes remain literal", () => {
  expect(htmlToMarkdown("<h1>a<br>b</h1>")?.markdown).toBe("# a b");
  expect(htmlToMarkdown('<a href="u">a<br>b</a>')?.markdown).toBe("[a b](u)");
  expect(htmlToMarkdown("<p>a<br>b</p>")?.markdown).toBe("a\\\nb");
  expect(htmlToMarkdown("a &amp; b")?.markdown).toBe("a \\& b");
  expect(htmlToMarkdown("&amp;#8288;")?.markdown).toBe("\\&#8288;");
});

it.each(["Lezer", "CommonMark"] as const)("%s oracle self-tests name every rejection", (parser) => {
  for (const [html, markdown, reason] of [
    ["<b>a</b>", "**b**", "text differs"],
    ["<b>a</b>", "a", "word char 0 restyled"],
    ["a", "**a**", "word char 0 restyled"],
    ["<b>a</b> <b>b</b>", "**a b**", "space 1 gained a style"],
    ["<b>a</b>.<b>b</b>", "**a.b**", "punctuation 1 gained a style"],
    ["<b>a.</b>", "**a**.", "punctuation 1 lost style"],
  ]) {
    expect(() => assertStyleParity(html, markdown, parser)).toThrow(
      new RegExp(`${parser}.*${reason}`)
    );
  }
});

it.each([
  ['<b>z</b><a href="u"><b>a<i>b</i></b><i>c</i></a>', "**z**[**a**&#8288;***b***&#8288;*c*](u)"],
  ['<i>z</i><a href="u"><i>a<b>b</b></i><b>c</b></a>', "*z*[*a*&#8288;***b***&#8288;**c**](u)"],
  [
    '<b>z</b><a href="u"><b><i>a</i>a<i>a</i></b></a>',
    "**z**[***a***&#8288;**a**&#8288;***a***](u)",
  ],
  ['<b>z</b><a href="u"><b>a <i>b</i> c</b></a>', "**z**[**a** ***b*** **c**](u)"],
  ['<b><a href="u">a<i>b</i></a></b>y', "[**a**&#8288;***b***](u)y"],
  ['<b><a href="u">x</a></b><i>y</i>', "**[x](u)**&#8288;*y*"],
  ['<b><a href="u">x</a></b>y', "[**x**](u)y"],
])("link labels beside outer regions pin separator placement: %s", (html, expected) => {
  const markdown = htmlToMarkdown(html)?.markdown as string;
  expect(markdown).toBe(expected);
  assertStyleParity(html, markdown);
});

it.each([
  ["<h1><b>a<br>b</b></h1>", "<h1><b>a b</b></h1>", "# **a b**"],
  ['<a href="u"><b>a<br>b</b></a>', '<a href="u"><b>a b</b></a>', "[**a b**](u)"],
  ["<p><b>a<br>b</b></p>", "<p><b>a<br>b</b></p>", "**a\\\nb**"],
])("heading and link break folding preserves styles in both oracles: %s", (html, parityHtml, expected) => {
  const markdown = htmlToMarkdown(html)?.markdown as string;
  expect(markdown).toBe(expected);
  // Headings and labels fold breaks to spaces; paragraphs retain a hard break.
  assertStyleParity(parityHtml, markdown);
});

it("code reference bytes remain opaque next to a separator", () => {
  const html = "<b><code>&amp;#8288;</code></b><i>x</i>";
  const markdown = htmlToMarkdown(html)?.markdown as string;
  expect(markdown).toBe("**`&#8288;`**&#8288;*x*");
  assertStyleParity(html, markdown);
});

it.each([
  '<b>!</b><b><a href="u">x</a></b>',
  '!<a href="u">x</a>',
  '!<b><a href="u">x</a></b>',
])("a ! before a link remains a link in both ASTs: %s", (html) => {
  const markdown = htmlToMarkdown(html)?.markdown as string;
  const names: string[] = [];
  const visit = (node: ReturnType<Parser["parse"]>): void => {
    names.push(node.type);
    for (let child = node.firstChild; child; child = child.next) {
      visit(child);
    }
  };
  visit(new Parser().parse(markdown));
  expect(names).toContain("link");
  expect(names).not.toContain("image");
  assertStyleParity(html, markdown);
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
    ["link inside strong", '<b><a href="https://example.com">x</a></b>y'],
    ["link beside strong", '<a href="https://example.com">x</a><b>y</b>'],
    ["code beside strong", "<b>a</b><code>b</code>"],
    ["code beside emphasis", "<code>a</code><i>b</i>"],
    ["break between strong runs", "<b>a</b><br><b>b</b>"],
    ["star inside strong", "<b>a*b</b>c"],
    ["underscore inside emphasis", "<i>a_b</i>c"],
    ["ampersand inside strong", "<b>a&amp;b</b>"],
    ["brackets inside strong", "<b>[a]</b>b"],
  ])("%s", (_name, html) => {
    roundTrip(html);
  });

  // Decision 1 balances complete regions and closes before neutral content.
  it.each([
    [
      "strong then italic after nested italic",
      "<b>a<i>b</i></b><i>c</i>",
      "**a**&#8288;***b***&#8288;*c*",
    ],
    [
      "italic then strong after nested strong",
      "<i>a<b>b</b></i><b>c</b>",
      "*a*&#8288;***b***&#8288;**c**",
    ],
  ])("%s", (_name, html, expected) => {
    expect(htmlToMarkdown(html)?.markdown).toBe(expected);
    expect(() => assertStyleParity(html, expected)).not.toThrow();
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
