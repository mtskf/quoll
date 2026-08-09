// A11Y-14 — the quote-ink contrast NUMBER, computed in CI.
//
// WHY THIS FILE EXISTS. cm-decoration-block-style.test.ts pins QUOTE_INK's exact
// `color-mix(...)` TEXT at both use sites. That proves the AA remediation was not
// reverted to a bare `descriptionForeground` passthrough; it proves nothing about
// the ratio the mix resolves to. An edit that under-corrects the mix and updates
// both literals to match ships an AA-non-compliant colour with CI fully green —
// the same silent-failure shape A11Y-10 existed to close. `pnpm a11y:probe`
// computes real numbers from a real Chromium, but it is dev-only and absent from
// .github/workflows/, so nothing in CI ever saw a ratio. This file is that number,
// evaluated as pure maths so it needs no browser and runs in `pnpm test:unit`.
//
// IT IS NOT A REPLACEMENT FOR THE PROBE. The probe measures what Chromium actually
// rendered, through the real cascade, on the real span. This file re-implements a
// deliberately TINY slice of CSS colour resolution (var / color-mix / source-over
// compositing) over the same inputs. Two independent models of one colour is the
// point: the probe catches cascade/DOM regressions this cannot see (a rule that
// stops applying, a span that stops inheriting), and this catches value
// regressions in CI, which the probe cannot because it does not run there.
//
// THE MODEL WAS VALIDATED AGAINST THE PROBE, not asserted to match it. Run against
// the four shipped palettes it reproduces every ratio recorded in theme.ts's
// QUOTE_INK comment — light 5.24 / 5.06 / 4.85 exactly (depth 1 / 2 / 3), and
// dark, hc-light, hc-dark within 0.05 (the alpha-carrying palettes, where Chromium
// composites through more 8-bit steps than this does). It also reproduces the
// PRE-fix 4.44 that A11Y-10 was opened for, which is what the non-vacuity test at
// the bottom pins. Those numbers are provenance, not assertions: pinning them
// would turn every deliberate palette retune red for no accessibility reason. The
// contract asserted here is the AA threshold itself.
//
// EVERY INPUT IS SOURCED, NONE HARDCODED:
//   • the mix formula + the per-depth `--quoll-quote-ink-mix` step and fill —
//     from theme.ts's exported specs, so a source edit moves the measurement with it;
//   • the --vscode-* palettes — from scripts/preview/vscode-theme-palettes.mjs,
//     the same table the probe and the preview harness use. Hand-copied hex here
//     would be the registry-vs-theme-file trap in docs/LEARNING.md (a reviewer's
//     own draft of this test cited #1e1e1e as Default Light+ editor.foreground,
//     where the real value is #000000 via light_vs.json);
//   • --quoll-surface-fill — parsed out of the shipped styles.css theme blocks.
// Anything the resolver cannot parse THROWS. A future formula shape that this
// slice does not model must go red, never resolve to a confident wrong number.
import { readFileSync } from "node:fs";

import { type Tag, tags as t } from "@lezer/highlight";
import { describe, expect, it } from "vitest";

// @ts-expect-error — plain .mjs with no bundled types; vitest transpiles it.
import { PALETTES } from "../../scripts/preview/vscode-theme-palettes.mjs";
import { blockStyleThemeSpec, quollHighlightSpec } from "../../src/webview/cm/theme.js";

const AA_NORMAL_TEXT = 4.5; // WCAG 2.x AA, normal-size text

// ---------------------------------------------------------------------------
// A minimal CSS colour resolver: var() with fallback, color-mix(in srgb, …),
// hex, rgb()/rgba(), and `transparent`. Nothing else — see the throws.
// ---------------------------------------------------------------------------

type Rgba = { r: number; g: number; b: number; a: number };
type Vars = ReadonlyMap<string, string>;

/** Split on commas that are not inside parentheses (`var(--a, #000)` is one arg). */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
    } else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim());
}

/** Split on whitespace that is not inside parentheses. */
function splitTopLevelSpace(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text.trim()) {
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
    }
    if (/\s/.test(ch) && depth === 0) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) {
    parts.push(current);
  }
  return parts;
}

/** The inside of `name( … )`, or null if `text` is not that call. */
function callArgs(text: string, name: string): string | null {
  return text.startsWith(`${name}(`) && text.endsWith(")") ? text.slice(name.length + 1, -1) : null;
}

/**
 * Resolve `var(--x, fallback)` against `vars`. A missing variable with no
 * fallback throws rather than resolving to `transparent`: in this codebase the
 * fallback arm is load-bearing (a depth-1 quote line declares no
 * `--quoll-quote-ink-mix` at all and MUST land on the formula's `90%`), so
 * silently substituting a default would measure a colour no host produces.
 */
function resolveVar(expr: string, vars: Vars): string | null {
  const args = callArgs(expr, "var");
  if (args === null) {
    return null;
  }
  const [name, ...rest] = splitTopLevel(args);
  const declared = vars.get(name);
  if (declared !== undefined) {
    return declared;
  }
  if (rest.length === 0) {
    throw new Error(`quote-ink contrast: no value and no fallback for ${name} in ${expr}`);
  }
  return rest.join(",").trim();
}

/**
 * A `<percentage>` position, which may be a literal `90%` or a `var()` chain that
 * ends in one. Anything else throws: a percentage that does not parse is the
 * silent-50/50 failure this resolver must never fall back into.
 */
function resolvePercentage(expr: string, vars: Vars): number {
  const text = expr.trim();
  const dereferenced = resolveVar(text, vars);
  if (dereferenced !== null) {
    return resolvePercentage(dereferenced, vars);
  }
  const literal = /^([\d.]+)%$/.exec(text);
  if (!literal) {
    throw new Error(`quote-ink contrast: cannot resolve percentage ${JSON.stringify(expr)}`);
  }
  return Number.parseFloat(literal[1]);
}

function parseHex(text: string): Rgba | null {
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(text);
  if (short) {
    const [, r, g, b] = short;
    return {
      r: Number.parseInt(r + r, 16),
      g: Number.parseInt(g + g, 16),
      b: Number.parseInt(b + b, 16),
      a: 1,
    };
  }
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(text);
  if (!long) {
    return null;
  }
  return {
    r: Number.parseInt(long[1], 16),
    g: Number.parseInt(long[2], 16),
    b: Number.parseInt(long[3], 16),
    a: 1,
  };
}

function parseRgbFunction(text: string): Rgba | null {
  const args = callArgs(text, "rgba") ?? callArgs(text, "rgb");
  if (args === null) {
    return null;
  }
  const parts = splitTopLevel(args).map((p) => Number.parseFloat(p));
  const [r, g, b, a = 1] = parts;
  if (![r, g, b, a].every(Number.isFinite)) {
    throw new Error(`quote-ink contrast: unparseable rgb() components in ${text}`);
  }
  return { r, g, b, a };
}

/**
 * `color-mix(in srgb, A [p%], B [q%])`. Interpolation is PREMULTIPLIED (the CSS
 * Color 5 rule) so mixing toward a fully transparent colour does not drag the
 * result's hue — which is exactly the HC case here, where `--quoll-surface-fill`
 * is `transparent` and the depth rules mix the editor foreground into it.
 */
function resolveColorMix(text: string, vars: Vars): Rgba | null {
  const args = callArgs(text, "color-mix");
  if (args === null) {
    return null;
  }
  const [space, first, second, ...extra] = splitTopLevel(args);
  if (space !== "in srgb" || second === undefined || extra.length > 0) {
    throw new Error(`quote-ink contrast: unsupported color-mix form ${text}`);
  }
  // A term is `<colour> [<percentage>]`, and the percentage may itself be a
  // `var()` — QUOTE_INK's is `var(--quoll-quote-ink-mix, 90%)`, which is the
  // entire A11Y-13 depth mechanism. Matching a trailing literal `N%` only would
  // leave that term weightless, silently mixing 50/50 and reporting a ratio for a
  // colour nothing renders (caught by the non-vacuity test at the bottom of this
  // file — which is why it is there).
  const term = (part: string): { color: string; weight: number | null } => {
    const tokens = splitTopLevelSpace(part);
    if (tokens.length < 2) {
      return { color: part.trim(), weight: null };
    }
    const last = tokens[tokens.length - 1];
    return {
      color: tokens.slice(0, -1).join(" "),
      weight: resolvePercentage(last, vars) / 100,
    };
  };
  const a = term(first);
  const b = term(second);
  // CSS normalises omitted/partial percentages; the two forms shipped here are
  // "A p%, B" and "A, B q%", both of which reduce to p and 1 - p.
  let wa: number;
  if (a.weight !== null && b.weight !== null) {
    wa = a.weight / (a.weight + b.weight);
  } else if (a.weight !== null) {
    wa = a.weight;
  } else if (b.weight !== null) {
    wa = 1 - b.weight;
  } else {
    wa = 0.5;
  }
  const wb = 1 - wa;
  const ca = resolveColor(a.color, vars);
  const cb = resolveColor(b.color, vars);
  const alpha = ca.a * wa + cb.a * wb;
  if (alpha === 0) {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  const channel = (k: "r" | "g" | "b") => (ca[k] * ca.a * wa + cb[k] * cb.a * wb) / alpha;
  return { r: channel("r"), g: channel("g"), b: channel("b"), a: alpha };
}

function resolveColor(expr: string, vars: Vars): Rgba {
  const text = expr.trim();
  const dereferenced = resolveVar(text, vars);
  if (dereferenced !== null) {
    return resolveColor(dereferenced, vars);
  }
  if (text === "transparent") {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  const mixed = resolveColorMix(text, vars);
  if (mixed !== null) {
    return mixed;
  }
  return (
    parseHex(text) ??
    parseRgbFunction(text) ??
    (() => {
      throw new Error(`quote-ink contrast: cannot resolve colour ${JSON.stringify(expr)}`);
    })()
  );
}

/** Composite a possibly-translucent `top` over an opaque `bottom` (source-over). */
function compositeOver(top: Rgba, bottom: Rgba): Rgba {
  return {
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  };
}

function relativeLuminance({ r, g, b }: Rgba): number {
  const channel = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(fg: Rgba, bg: Rgba): number {
  const [hi, lo] = [relativeLuminance(fg), relativeLuminance(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------------------
// Inputs, all read from what ships.
// ---------------------------------------------------------------------------

const stylesCss = readFileSync(new URL("../../src/webview/styles.css", import.meta.url), "utf8");
// Comments stripped first: a commented-out declaration must not be mistaken for a
// live one (the vacated-guard trap in memory `quoll-source-contract-grep-vacuated-by-comment-literal`).
const liveCss = stylesCss.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * The theme class each themeKind puts on the document — the same mapping shell.ts
 * applies (`dark-theme` / `light-theme`, plus `hc-theme` for both HC kinds).
 * `--quoll-surface-fill` is a QUOLL token, not a `--vscode-*` one, so it is not in
 * the palette module; it is read from the shipped stylesheet instead of restated.
 */
const THEME_BLOCK_SELECTOR: Record<string, string> = {
  light: ".light-theme",
  dark: ".dark-theme",
  "hc-light": ":root.hc-theme",
  "hc-dark": ":root.hc-theme",
};

function surfaceFillFor(themeKind: string): string {
  const selector = THEME_BLOCK_SELECTOR[themeKind];
  if (selector === undefined) {
    throw new Error(`quote-ink contrast: no theme block mapped for themeKind "${themeKind}"`);
  }
  // One nesting level (`@layer theme { … }`) is handled implicitly: `[^{}]+`
  // cannot span a brace, so the inner rules match as if they were top level.
  const blocks = [...liveCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(
    ([, sel, body]) => sel.includes(selector) && body.includes("--quoll-surface-fill:")
  );
  if (blocks.length !== 1) {
    throw new Error(
      `quote-ink contrast: expected exactly one "${selector}" block declaring ` +
        `--quoll-surface-fill in styles.css, found ${blocks.length}`
    );
  }
  const decl = /--quoll-surface-fill:\s*([^;]+);/.exec(blocks[0][2]);
  if (!decl) {
    throw new Error(`quote-ink contrast: no --quoll-surface-fill value in the "${selector}" block`);
  }
  return decl[1].trim();
}

function varsFor(themeKind: string): Vars {
  const palette = PALETTES[themeKind] as Record<string, string> | undefined;
  if (!palette) {
    throw new Error(`quote-ink contrast: no palette for themeKind "${themeKind}"`);
  }
  // Palette keys are the `--vscode-` suffix with `.` already flattened to `-`
  // (e.g. `editor-foreground`), matching what the harness emits into :root. A
  // token the palette OMITS is omitted on purpose (the registry default is null,
  // so a real host emits nothing either) and must therefore reach its CSS
  // fallback — which is what leaving it out of this map does.
  return new Map(Object.entries(palette).map(([token, value]) => [`--vscode-${token}`, value]));
}

const byTag = (tag: Tag) =>
  quollHighlightSpec.find((e) => (Array.isArray(e.tag) ? e.tag.includes(tag) : e.tag === tag));

const blockSpec = blockStyleThemeSpec as Record<string, Record<string, string>>;
const QUOTE_INK = String(byTag(t.quote)?.color);
const BASE_RULE = blockSpec[".cm-line.quoll-blockquote"];

/**
 * The three panel levels a quote line can render at, read off the theme spec.
 * Depth 4+ is deliberately absent: blockquoteDepthClass clamps at
 * BLOCKQUOTE_MAX_DEPTH, so deeper lines reuse the depth-3 rule (pinned in
 * cm-decoration-block-style.test.ts). Each level pairs the fill the ink sits on
 * with the `--quoll-quote-ink-mix` that level declares — an added depth rule that
 * deepens the fill without its ink step would land here as a sub-AA number.
 */
const PANEL_LEVELS = [
  { label: "depth-1 (base panel)", fill: BASE_RULE?.backgroundColor, inkMix: undefined },
  {
    label: "depth-2 (nested)",
    fill: blockSpec[".cm-line.quoll-blockquote-depth-2"]?.backgroundColor,
    inkMix: blockSpec[".cm-line.quoll-blockquote-depth-2"]?.["--quoll-quote-ink-mix"],
  },
  {
    label: "depth-3 (nested)",
    fill: blockSpec[".cm-line.quoll-blockquote-depth-3"]?.backgroundColor,
    inkMix: blockSpec[".cm-line.quoll-blockquote-depth-3"]?.["--quoll-quote-ink-mix"],
  },
] as const;

/**
 * The ratio a reader sees for quoted prose at one panel level under one palette.
 * The ink is composited over the panel and the panel over the editor canvas,
 * because WCAG contrast is defined on COMPOSITED colours and both the HC surface
 * fill and three of the four `descriptionForeground` values carry alpha —
 * treating those as opaque would report a ratio nobody sees, on exactly the token
 * this check is about.
 */
function quoteInkRatio(themeKind: string, level: { fill?: string; inkMix?: string }): number {
  const vars = new Map(varsFor(themeKind));
  vars.set("--quoll-surface-fill", surfaceFillFor(themeKind));
  if (level.inkMix !== undefined) {
    vars.set("--quoll-quote-ink-mix", level.inkMix);
  }
  if (level.fill === undefined) {
    throw new Error(`quote-ink contrast: theme spec declared no fill for ${themeKind}`);
  }
  const canvas = resolveColor("var(--vscode-editor-background)", vars);
  const panel = compositeOver(resolveColor(level.fill, vars), canvas);
  const ink = compositeOver(resolveColor(QUOTE_INK, vars), panel);
  return contrastRatio(ink, panel);
}

const THEME_KINDS = Object.keys(PALETTES) as string[];

describe("quote ink resolves above the AA floor on every shipped palette (A11Y-14)", () => {
  it("measures the ONE formula both use sites carry", () => {
    // The `t.quote` span paints essentially all visible quoted text and the
    // `.cm-line.quoll-blockquote` rule paints the rest (rationale: QUOTE_INK in
    // theme.ts). They are one constant in source; asserting they are still equal is
    // what lets every ratio below be computed from a single string.
    expect(QUOTE_INK).toContain("color-mix(");
    expect(BASE_RULE?.color).toBe(QUOTE_INK);
  });

  it("actually generated a case per themeKind and panel level", () => {
    // The AA cases below are GENERATED from these two lists, so an empty one would
    // make this whole file vacuously green — the exact shape of failure it exists to
    // remove. The kinds are derived from the palette module rather than restated
    // here (test/build/theme-palettes.test.ts pins that list equal to the wire
    // vocabulary), so a fifth palette widens the sweep instead of going unmeasured.
    expect(THEME_KINDS.length).toBeGreaterThanOrEqual(4);
    expect(PANEL_LEVELS.length).toBe(3);
  });

  for (const themeKind of THEME_KINDS) {
    for (const level of PANEL_LEVELS) {
      it(`clears ${AA_NORMAL_TEXT}:1 in ${themeKind} at ${level.label}`, () => {
        const ratio = quoteInkRatio(themeKind, level);
        // The measured ratio rides in the failure message the way the probe reports
        // it, so a red run says how far under AA the mix landed and against which
        // palette — not merely that it did.
        expect(
          ratio,
          `${themeKind} ${level.label}: ${ratio.toFixed(2)}:1 (AA normal text ` +
            `${AA_NORMAL_TEXT}:1); palette: scripts/preview/vscode-theme-palettes.mjs`
        ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      });
    }
  }
});

describe("the AA check is non-vacuous", () => {
  it("goes red for the un-nudged ink this remediation replaced", () => {
    // `--quoll-quote-ink-mix: 100%` is the bare host descriptionForeground — the
    // pre-A11Y-10 colour, which measured 4.44:1 on the light quote panel. If this
    // computed >= 4.5 the whole file would be measuring something other than the
    // mix, and every green assertion above would be worthless.
    const bare = quoteInkRatio("light", { fill: BASE_RULE?.backgroundColor, inkMix: "100%" });
    expect(bare).toBeLessThan(AA_NORMAL_TEXT);
    const shipped = quoteInkRatio("light", PANEL_LEVELS[0]);
    expect(shipped).toBeGreaterThan(bare);
  });

  it("refuses to guess at a colour form it does not model", () => {
    // A future formula shape (a relative colour, an lch() mix, a gradient) must
    // fail loudly here rather than resolve to a confident wrong number — the
    // failure mode this file exists to remove, reintroduced one level down.
    expect(() => resolveColor("lch(50% 40 30)", new Map())).toThrow(/cannot resolve colour/);
    expect(() => resolveColor("color-mix(in oklab, #000 50%, #fff)", new Map())).toThrow(
      /unsupported color-mix form/
    );
  });
});
