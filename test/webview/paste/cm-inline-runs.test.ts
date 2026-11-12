// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { gfmParser } from "../../../src/markdown/gfm-parser.js";
import { htmlToMarkdown } from "../../../src/webview/cm/paste/html-to-markdown.js";
import {
  BOLD,
  CapExceeded,
  type InlineAtom,
  InlineRepairCapExceeded,
  ITALIC,
  type RepairBudget,
  type StyleMask,
  serializeInlineRuns,
} from "../../../src/webview/cm/paste/inline-runs.js";
import { assertStyleParity } from "./inline-style-oracle.js";

// A byte-for-byte copy of the converter's private `escapeInline`
// (src/webview/cm/paste/html-to-markdown.ts). The serializer takes the escaper as
// an injected option, so these unit tests pin it with the same escaping the
// converter passes in.
function escapeInline(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/[`*_[\]<~=&|]/g, "\\$&");
}

const ZWJ = String.fromCharCode(0x200d); // U+200D ZERO WIDTH JOINER

const t = (text: string, style: StyleMask = 0): InlineAtom => ({ kind: "text", text, style });
const br = (style: StyleMask = 0): InlineAtom => ({ kind: "break", style });
const code = (markdown: string, style: StyleMask = 0): InlineAtom => ({
  kind: "code",
  markdown,
  style,
});

function run(atoms: readonly InlineAtom[], trimEdges = false) {
  return serializeInlineRuns(atoms, {
    trimEdges,
    escapeText: escapeInline,
    repairBudget: { remaining: Number.POSITIVE_INFINITY },
  });
}
const md = (atoms: readonly InlineAtom[], trimEdges = false): string =>
  run(atoms, trimEdges).markdown;

const B = BOLD;
const I = ITALIC;

describe("serializeInlineRuns", () => {
  it("merges adjacent runs of the same style", () => {
    expect(md([t("A", B), t("B", B)])).toBe("**AB**");
  });

  it("closes one style and opens the next at a style change", () => {
    // Decision 1 balances complete regions and closes before neutral content; separators avoid mixed-boundary repair.
    expect(md([t("A", B), t("B", I)])).toBe("**A**&#8288;*B*");
  });

  it("keeps an interior space's source style", () => {
    expect(md([t("a", B), t(" ", 0), t("b", B)])).toBe("**a** **b**");
    expect(md([t("a b", B)])).toBe("**a b**");
  });

  it("drops the style of a space at a run edge", () => {
    expect(md([t("foo ", B), t("bar", 0)])).toBe("**foo** bar");
  });

  it("emits no markers and no syntax flag for a lone joiner", () => {
    expect(run([t(ZWJ, B)])).toEqual({ markdown: ZWJ, emittedSyntax: false });
  });

  it("keeps a style across a hard break inside the run", () => {
    expect(md([t("a", B), br(B), t("b", B)])).toBe("**a\\\nb**");
  });

  it("trims space and break units at the edges when asked", () => {
    expect(md([br(0), t("a", 0), t(" ", 0)], true)).toBe("a");
  });

  it("emits code spans verbatim and reports only marker syntax", () => {
    expect(run([code("`x`", 0)])).toEqual({ markdown: "`x`", emittedSyntax: false });
    expect(run([code("`x`", B)])).toEqual({ markdown: "**`x`**", emittedSyntax: true });
  });
});

const link = (label: InlineAtom[], style: StyleMask = 0, destination = "u"): InlineAtom => ({
  kind: "link",
  label,
  destination,
  style,
});

it("closes regions before neutral stretches", () => {
  expect(md([t("a", B), t(" ", B), t("b", B | I), t(" ", B), t("c", B)])).toBe(
    "**a** ***b*** **c**"
  );
  expect(md([t("a", B | I), t(" ", B), t("b", B | I)])).toBe("***a*** ***b***");
  expect(md([t("a", B), t(" ", 0), t("b", B)])).toBe("**a** **b**");
  expect(md([t("a", B), t(" ", B), t("b", B)])).toBe("**a b**");
  expect(run([t(ZWJ, B)])).toEqual({ markdown: ZWJ, emittedSyntax: false });
  expect(md([t("a", B), t(" ", B), t(" ", 0), t("b", B)])).toBe("**a**  **b**");
  expect(md([t("a", B), t(ZWJ, 0), t("b", B)])).toBe(`**a**${ZWJ}**b**`);
  expect(md([t("a", B), br(B), t("b", B)])).toBe("**a\\\nb**");
});

it("inserts one separator only between touching balanced regions", () => {
  const marker = ["", "**", "*", "***"];
  for (let a = 0; a < 4; a++) {
    for (let b = 0; b < 4; b++) {
      const expected =
        a === b
          ? `${marker[a]}xy${marker[a]}`
          : `${marker[a]}x${marker[a]}${a && b ? "&#8288;" : ""}${marker[b]}y${marker[b]}`;
      expect(md([t("x", a), t("y", b)])).toBe(expected);
    }
  }
});

it("balanced transitions need no repair budget", () => {
  const budget = { remaining: 0 };
  expect(
    serializeInlineRuns([t("a", B), t("b", B | I), t("c", I)], {
      trimEdges: false,
      escapeText: escapeInline,
      repairBudget: budget,
    }).markdown
  ).toBe("**a**&#8288;***b***&#8288;*c*");
  expect(
    serializeInlineRuns([t("a", I), t("b", B | I), t("c", B)], {
      trimEdges: false,
      escapeText: escapeInline,
      repairBudget: budget,
    }).markdown
  ).toBe("*a*&#8288;***b***&#8288;**c**");
  expect(
    serializeInlineRuns([t("a", B | I), t("b", B), t("c", B | I)], {
      trimEdges: false,
      escapeText: escapeInline,
      repairBudget: budget,
    }).markdown
  ).toBe("***a***&#8288;**b**&#8288;***c***");
});

describe("link atoms", () => {
  it("serialises the label's own emphasis inside the brackets", () => {
    expect(run([link([t("x", B)])])).toEqual({ markdown: "[**x**](u)", emittedSyntax: true });
  });

  it("wraps the whole link in its outer style", () => {
    expect(md([link([t("x", 0)], B)])).toBe("**[x](u)**");
  });

  it("folds a break in the label to a single space", () => {
    expect(md([link([t("a", 0), br(0), t("b", 0)])])).toBe("[a b](u)");
  });

  it("keeps label-edge spaces (they are not segment edges)", () => {
    expect(md([link([t(" x ", 0)])], true)).toBe("[ x ](u)");
  });
});

describe("nested emission", () => {
  it("keeps the longer-running style outermost", () => {
    // Decision 1 balances complete regions and closes before neutral content; separators avoid mixed-boundary repair.
    expect(md([t("A", B | I), t("B", I), t("C", B)])).toBe("***A***&#8288;*B*&#8288;**C**");
  });

  it("never opens a marker right before a neutral unit (leading space)", () => {
    // Decision 1 balances complete regions and closes before neutral content; separators avoid mixed-boundary repair.
    expect(md([t("a", B), t("a", B | I), t(" a", I)])).toBe("**a**&#8288;***a*** *a*");
  });

  it("never opens a marker right before a neutral unit (trailing space)", () => {
    // Decision 1 balances complete regions and closes before neutral content; separators avoid mixed-boundary repair.
    expect(md([t("a", I), t("a ", B | I), t("a", B)])).toBe("*a*&#8288;***a*** **a**");
  });
});

describe("flanking repair", () => {
  it("demotes a closing colon out of the run (Note:)", () => {
    expect(md([t("Note:", B), t("text", 0)])).toBe("**Note**:text");
  });

  it("demotes both parentheses when both sides fail", () => {
    expect(md([t("x", 0), t("(a)", B), t("b", 0)])).toBe("x(**a**)b");
  });

  it("demotes CJK brackets (「重要」)", () => {
    expect(md([t("これは", 0), t("「重要」", B), t("です", 0)])).toBe("これは「**重要**」です");
  });

  it("demotes only the failing side", () => {
    expect(md([t("(a)", B), t("b", 0)])).toBe("**(a**)b");
  });

  it("treats an astral neighbour as a word character", () => {
    expect(md([t("a.", B), t("😀", 0)])).toBe("**a**.😀");
    expect(md([t("😀", 0), t("(a)", B)])).toBe("😀(**a)**");
  });

  it("classifies a closer-plus-opener marker run as one group", () => {
    // Decision 1 balances complete regions and closes before neutral content; separators avoid mixed-boundary repair.
    expect(md([t("a", B), t("a", B | I), t("(a)", I)])).toBe("**a**&#8288;***a***&#8288;*(a)*");
  });

  it("never leaves markers around a lone joiner a demotion split off", () => {
    expect(run([t(`${ZWJ}:`, B), t("a", 0)])).toEqual({
      markdown: `**${ZWJ}:**&#97;`,
      emittedSyntax: true,
    });
    expect(run([t("a", 0), t(`(${ZWJ}`, B)])).toEqual({
      markdown: `&#97;**(${ZWJ}**`,
      emittedSyntax: true,
    });
    assertStyleParity(`<b>${ZWJ}:</b>a`, md([t(`${ZWJ}:`, B), t("a", 0)]));
    assertStyleParity(`a<b>(${ZWJ}</b>`, md([t("a", 0), t(`(${ZWJ}`, B)]));
  });

  it("rechecks a punctuation run after transferring its link style", () => {
    const out = md([t("w", 0), link([t("x", 0)], B), t(".", B), t("z", 0)], true);
    expect(out).toBe("w[**x**](u)**.**&#122;");
    assertStyleParity('w<b><a href="u">x</a>.</b>z', out);
  });

  it("rechecks a punctuation run after an earlier demotion", () => {
    const out = md([t("a", 0), t(".", B), t(`${ZWJ}.`, B), t("a", 0)]);
    expect(out).toBe(`a.**${ZWJ}.**&#97;`);
    assertStyleParity(`a<b>.${ZWJ}.</b>a`, out);
  });

  it("keeps enclosing bold after a nested link transfer", () => {
    const html = '<b>a<i><a href="https://example.com">x</a>.</i>a</b>';
    const out = htmlToMarkdown(html)?.markdown;
    expect(out).toBeTypeOf("string");
    assertStyleParity(html, out as string);
  });

  it("leaves a flanking closer before a trimmed edge alone", () => {
    expect(md([t("a.", B), t(" ", 0)], true)).toBe("**a.**");
  });
});

describe("link-edge repair", () => {
  it("moves a link's outer style into its label when the bracket breaks flanking", () => {
    expect(md([t("see ", B), link([t("x", 0)], B), t("y", 0)])).toBe("**see** [**x**](u)y");
  });
});

describe("entity fallback", () => {
  it("encodes the word char after a code span's closer", () => {
    expect(md([code("`x`", B), t("y", 0)])).toBe("**`x`**&#121;");
  });

  it("encodes the word char after an all-punctuation run", () => {
    expect(md([t(".", B), t("a", 0)])).toBe("**.**&#97;");
  });

  it("encodes an astral neighbour as one code point, never a surrogate", () => {
    expect(md([code("`x`", B), t("😀", 0)])).toBe("**`x`**&#128512;");
  });

  it("still escapes a literal ampersand, so a reference cannot collide", () => {
    expect(md([t("&", 0)])).toBe("\\&");
  });

  it.each([
    // Decision 1 balances complete regions and closes before neutral content; separators avoid mixed-boundary repair.
    ["closing", [t(`${ZWJ}a`, B), t(".", I)], `**${ZWJ}a**&#8288;*.*`, `<b>${ZWJ}a</b><i>.</i>`],
    // Decision 1 balances complete regions and closes before neutral content; separators avoid mixed-boundary repair.
    ["opening", [t(".", I), t(`a${ZWJ}`, B)], `*.*&#8288;**a${ZWJ}**`, `<i>.</i><b>a${ZWJ}</b>`],
  ] as const)("keeps a raw joiner beside an encoded %s word edge", (_edge, atoms, expected, html) => {
    const out = md(atoms);
    expect(out).toBe(expected);
    assertStyleParity(html, out);
  });

  it("re-checks after each repair until the cascade settles", () => {
    // Decision 1 balances complete regions and closes before neutral content; separators avoid mixed-boundary repair.
    expect(md([t("a", 0), t("a", B), t(".", I)])).toBe("a**a**&#8288;*.*");
  });
});

describe("repair cap", () => {
  // Decision 1 full-region balance removes the old cascade; this fixture still needs two repairs.
  const cascade = [t("a", 0), t(".", B), t("a", 0)];
  const capped = (repairBudget: RepairBudget) => () =>
    serializeInlineRuns(cascade, { trimEdges: false, escapeText: escapeInline, repairBudget });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws the typed cap error, silently, when no repair is allowed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let caught: unknown;
    try {
      capped({ remaining: 0 })();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InlineRepairCapExceeded);
    expect(caught).toBeInstanceOf(CapExceeded);
    expect(warn).not.toHaveBeenCalled();
  });

  it("charges one budget across calls, so the total work is bounded", () => {
    const probe = { remaining: 1_000_000 };
    capped(probe)();
    const perCall = 1_000_000 - probe.remaining;
    expect(perCall).toBeGreaterThan(0);
    const shared = { remaining: perCall };
    expect(capped(shared)()).toEqual({ markdown: "&#97;**.**&#97;", emittedSyntax: true });
    expect(shared.remaining).toBe(0);
    expect(capped(shared)).toThrow(InlineRepairCapExceeded);
  });

  it("throws when the budget runs out mid-cascade", () => {
    const probe = { remaining: 1_000_000 };
    capped(probe)();
    expect(capped({ remaining: 1_000_000 - probe.remaining - 1 })).toThrow(InlineRepairCapExceeded);
  });

  it("charges a large code span or link for every pass that re-renders it", () => {
    const big = "x".repeat(100_000);
    const spent = (atoms: InlineAtom[]): number => {
      const probe = { remaining: 1_000_000 };
      serializeInlineRuns(atoms, {
        trimEdges: false,
        escapeText: escapeInline,
        repairBudget: probe,
      });
      return 1_000_000 - probe.remaining;
    };
    // One repair (the `Note:` colon is demoted), so one re-serialisation pass.
    expect(spent([code(`\`${big}\``, 0), t("Note:", B), t("a", 0)])).toBeGreaterThan(100_000);
    expect(spent([link([t(big, 0)]), t("Note:", B), t("a", 0)])).toBeGreaterThan(100_000);
    expect(spent([link([t("x", 0)], 0, big), t("Note:", B), t("a", 0)])).toBeGreaterThan(100_000);
  });

  it("batches independent repairs into one pass", () => {
    const line = [t("Note:", B), t("text here", 0), br()];
    const spent = (atoms: InlineAtom[]): number => {
      const probe = { remaining: 1e9 };
      serializeInlineRuns(atoms, {
        trimEdges: false,
        escapeText: escapeInline,
        repairBudget: probe,
      });
      return 1e9 - probe.remaining;
    };
    // One pass per repair would grow with the square of the line count; batched,
    // 600 lines cost what 600 single lines cost apart.
    expect(spent(Array.from({ length: 600 }, () => line).flat())).toBeLessThanOrEqual(
      600 * spent(line)
    );
  });

  it("does not spend a repair on checking a settled result", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const probe = { remaining: 1_000_000 };
    capped(probe)();
    // Exactly the repairs' cost: the final, settled pass is free.
    expect(capped({ remaining: 1_000_000 - probe.remaining })().markdown).toBe("&#97;**.**&#97;");
    expect(warn).not.toHaveBeenCalled();
  });
});

// Converter output re-read by Lezer (the editor's parser) must style the same chars
// the HTML did; see inline-style-oracle.ts.
describe("re-parse round trip", () => {
  const roundTrip = (html: string) => () => {
    const out = htmlToMarkdown(html)?.markdown;
    expect(out).toBeTypeOf("string");
    assertStyleParity(html, out as string);
  };

  it(
    "closes before the space when a styled space meets an unstyled break",
    roundTrip("<p><b>a </b><br><b>b</b></p>")
  );
  it(
    "closes before the space when a styled space meets an unstyled space",
    roundTrip("<p><b>a </b> <b>b</b></p>")
  );
});

describe("neutral stretches", () => {
  it("closes a styled space's run before an unstyled break", () => {
    expect(md([t("a ", B), br(0), t("b", B)])).toBe("**a** \\\n**b**");
  });

  it("closes a styled space's run before an unstyled space, without an entity", () => {
    expect(md([t("a ", B), t(" ", 0), t("b", B)])).toBe("**a**  **b**");
  });
});

describe("a `!` before a link", () => {
  const nodeNames = (markdown: string): Set<string> => {
    const names = new Set<string>();
    gfmParser.parse(markdown).iterate({
      enter: (n) => {
        names.add(n.name);
      },
    });
    return names;
  };
  const expectLinkNotImage = (markdown: string) => {
    const names = nodeNames(markdown);
    expect(names.has("Link")).toBe(true);
    expect(names.has("Image")).toBe(false);
  };

  it("escapes a `!` that a same-style merge puts right before `[`", () => {
    const html = '<p><b>!</b><b><a href="https://example.com">Read me</a></b></p>';
    const out = htmlToMarkdown(html)?.markdown as string;
    expect(out).toBe("**\\![Read me](https://example.com)**");
    expectLinkNotImage(out);
  });

  it("escapes an unstyled `!` right before `[`", () => {
    const html = '<p>!<a href="https://example.com">Read me</a></p>';
    const out = htmlToMarkdown(html)?.markdown as string;
    expectLinkNotImage(out);
  });

  it("leaves a `!` a marker already separates from `[`, and every other `!`, alone", () => {
    expect(md([t("Hi!", 0), link([t("x", 0)], B)])).toBe("Hi!**[x](u)**");
    expect(md([t("Hi! there", 0)])).toBe("Hi! there");
  });
});
