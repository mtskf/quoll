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
// dark, hc-light, hc-dark to within ~0.06 (the alpha-carrying palettes, where
// Chromium composites through more 8-bit steps than this does). That bound is
// deliberately stated at FULL precision: the worst cell is hc-dark depth-1, which
// resolves to 10.8381 here against the probe's recorded 10.89 — a delta of 0.052,
// so a tighter-sounding "within 0.05" would be false. (The recorded figures are
// themselves 2dp, so the real delta is only pinned to ±0.005 either way.) It also
// reproduces the PRE-fix 4.44 that A11Y-10 was opened for, which is what the
// non-vacuity test at the bottom pins. Those numbers are provenance, not
// assertions: pinning them would turn every deliberate palette retune red for no
// accessibility reason. The contract asserted here is the AA threshold itself.
//
// EVERY COLOUR INPUT IS SOURCED, NONE HARDCODED:
//   • the mix formula + the per-depth `--quoll-quote-ink-mix` step and fill —
//     from theme.ts's exported specs, so a source edit moves the measurement with it;
//   • the --vscode-* palettes — from scripts/preview/vscode-theme-palettes.mjs,
//     the same table the probe and the preview harness use. Hand-copied hex here
//     would be the registry-vs-theme-file trap in docs/LEARNING.md (a reviewer's
//     own draft of this test cited #1e1e1e as Default Light+ editor.foreground,
//     where the real value is #000000 via light_vs.json);
//   • --quoll-surface-fill — parsed out of the shipped styles.css theme blocks.
// The one NON-colour input that is restated rather than read is
// THEME_BLOCK_SELECTOR below (themeKind → the class shell.ts puts on the
// document): shell.ts applies it in code, so there is no table to import. That
// restatement is safe because it is fail-LOUD — a renamed theme class makes
// surfaceFillFor's "exactly one block" guard throw rather than quietly measure the
// wrong theme block, which is the only failure shape this file cares about.
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
  const [, r, g, b] = long;
  return {
    r: Number.parseInt(r, 16),
    g: Number.parseInt(g, 16),
    b: Number.parseInt(b, 16),
    a: 1,
  };
}

/**
 * `rgb(r, g, b)` / `rgba(r, g, b, a)` in UNITLESS comma notation only. Everything
 * else throws, because every other form parses "successfully" into the wrong
 * number: `Number.parseFloat` stops at the `%`, so `rgb(50%, 50%, 50%)` would read
 * as channels of 50 (CSS renders 127.5) and `rgba(0, 0, 0, 50%)` as an alpha of 50,
 * which compositeOver then multiplies through as `top * 50 + bottom * -49`. All of
 * those stay finite, so a `Number.isFinite` check passes them and a fabricated
 * ratio is reported — the confident-wrong-number failure this whole file exists to
 * remove, one level down. The live palettes do carry `rgba(204, 204, 204, 0.7)`-style
 * values (vscode-theme-palettes.mjs), and that module's header says its arms are
 * refreshed BY HAND, so the `%` variant is one hand-edit away.
 */
function parseRgbFunction(text: string): Rgba | null {
  const args = callArgs(text, "rgba") ?? callArgs(text, "rgb");
  if (args === null) {
    return null;
  }
  const raw = splitTopLevel(args);
  if (raw.length < 3 || raw.length > 4) {
    throw new Error(
      `quote-ink contrast: expected 3 or 4 rgb() components in ${text}, got ${raw.length}`
    );
  }
  const parts = raw.map((p) => {
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(p)) {
      throw new Error(
        `quote-ink contrast: unsupported rgb() component ${JSON.stringify(p)} in ${text} ` +
          "(only unitless numbers are modelled — no %, no `/` alpha)"
      );
    }
    return Number.parseFloat(p);
  });
  const [r, g, b, a = 1] = parts;
  if (a < 0 || a > 1) {
    throw new Error(`quote-ink contrast: rgb() alpha ${a} outside 0..1 in ${text}`);
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
    // With BOTH percentages given, CSS normalises the pair to p/(p+q) and q/(p+q)
    // AND — when they sum under 100% — scales the RESULT's alpha by (p+q)/100.
    // Modelling only the normalisation returns a confidently wrong alpha (e.g.
    // `color-mix(in srgb, #ffffff 20%, transparent 20%)` is a: 0.2 in CSS, 0.5 with
    // normalisation alone). Nothing that ships takes this form — QUOTE_INK weights
    // term A only, the depth fills weight term B only — so reject the shape rather
    // than half-model it.
    if (Math.abs(a.weight + b.weight - 1) > 1e-9) {
      throw new Error(
        "quote-ink contrast: color-mix percentages that do not sum to 100% are not " +
          `modelled (CSS also scales the result alpha by sum/100) in ${text}`
      );
    }
    wa = a.weight;
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
  const parsed = resolveColorMix(text, vars) ?? parseHex(text) ?? parseRgbFunction(text);
  if (parsed === null) {
    throw new Error(`quote-ink contrast: cannot resolve colour ${JSON.stringify(expr)}`);
  }
  return parsed;
}

/** Composite a possibly-translucent `top` over an opaque `bottom` (source-over). */
function compositeOver(top: Rgba, bottom: Rgba): Rgba {
  if (bottom.a !== 1) {
    // The shortened formula below — and the `a: 1` it returns — hold ONLY for an
    // opaque backdrop; a translucent one needs the full source-over alpha division.
    // Every backdrop here comes from DATA (the palette's editor-background, then the
    // already-composited panel), so today this holds by the four tables happening to
    // give an opaque editor-background, not by construction. Assert the precondition
    // rather than let a future palette turn it into a wrong number.
    throw new Error(
      `quote-ink contrast: translucent backdrop (alpha ${bottom.a}) in compositeOver`
    );
  }
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
  const [, , body] = blocks[0];
  const decl = /--quoll-surface-fill:\s*([^;]+);/.exec(body);
  if (!decl) {
    throw new Error(`quote-ink contrast: no --quoll-surface-fill value in the "${selector}" block`);
  }
  return decl[1].trim();
}

/**
 * The three `--vscode-*` tokens the formulas here consume. All three have non-null
 * registry defaults in every themeKind, so a real host always emits them and an
 * absence from the TABLE is a table bug — a silent one, because QUOTE_INK carries
 * concrete `#616161` / `#000` fallbacks, so the run would measure a fixed grey on a
 * fixed black and report a confident ratio for a colour no host renders.
 *
 * Do NOT extend this list to other tokens. The palette module omits tokens whose
 * registry default IS null; a real host emits nothing for those, so reaching the
 * CSS fallback is the correct behaviour and requiring them would break that
 * convention (see the note on the map below).
 */
const REQUIRED_TOKENS = ["descriptionForeground", "editor-foreground", "editor-background"];

/**
 * `palette` is a parameter, defaulted to the shipped table, so the guards below can
 * be exercised directly: the `.mjs` import is `any`, so nothing but these runtime
 * checks stands between a malformed table and a silently-fallback measurement.
 */
function varsFor(themeKind: string, palette: unknown = PALETTES[themeKind]): Vars {
  if (typeof palette !== "object" || palette === null) {
    throw new Error(`quote-ink contrast: no palette for themeKind "${themeKind}"`);
  }
  const table = palette as Record<string, unknown>;
  for (const token of REQUIRED_TOKENS) {
    if (table[token] === undefined) {
      throw new Error(
        `quote-ink contrast: palette "${themeKind}" is missing ${token}; the measurement ` +
          "would silently fall back to a literal no host renders"
      );
    }
  }
  // Palette keys are the `--vscode-` suffix with `.` already flattened to `-`
  // (e.g. `editor-foreground`), matching what the harness emits into :root. A
  // token the palette OMITS is omitted on purpose (the registry default is null,
  // so a real host emits nothing either) and must therefore reach its CSS
  // fallback — which is what leaving it out of this map does. A non-STRING value is
  // the same silent failure wearing the other hat: `Object.entries` keeps the key,
  // so the Map holds it, `vars.get()` returns undefined and resolveVar cannot tell
  // it from an absent token — it takes the CSS fallback arm and measures a colour
  // no host produces. Omit is the supported way to say "this host emits nothing".
  return new Map(
    Object.entries(table).map(([token, value]) => {
      if (typeof value !== "string") {
        throw new Error(
          `quote-ink contrast: palette "${themeKind}" token "${token}" is ${typeof value}, not a ` +
            "colour string; a token a host does not emit must be OMITTED from the table " +
            "(so it reaches its CSS fallback), never set to a non-string"
        );
      }
      return [`--vscode-${token}`, value] as const;
    })
  );
}

/**
 * A colour off `quollHighlightSpec`, or a loud failure. `String(entry?.color)`
 * would turn a removed or renamed entry into the seven-character string
 * `"undefined"`, which does go red — but three steps later, inside the resolver
 * ("cannot resolve colour \"undefined\""), pointing the next reader at CSS parsing
 * instead of at the missing spec entry that actually broke.
 */
function specColor(tag: Tag, what: string): string {
  const entry = quollHighlightSpec.find((e) =>
    Array.isArray(e.tag) ? e.tag.includes(tag) : e.tag === tag
  );
  const color = entry?.color;
  if (typeof color !== "string") {
    throw new Error(
      `quote-ink contrast: quollHighlightSpec declares no string color for ${what} — the ` +
        "entry was removed or renamed in src/webview/cm/theme.ts"
    );
  }
  return color;
}

const blockSpec = blockStyleThemeSpec as Record<string, Record<string, string>>;
const QUOTE_INK = specColor(t.quote, "t.quote");
const BASE_RULE = blockSpec[".cm-line.quoll-blockquote"];

type PanelLevel = { label?: string; fill?: string; inkMix?: string };

/**
 * The three panel levels a quote line can render at, read off the theme spec.
 * Depth 4+ is deliberately absent: blockquoteDepthClass clamps at
 * BLOCKQUOTE_MAX_DEPTH, so deeper lines reuse the depth-3 rule (pinned in
 * cm-decoration-block-style.test.ts). Each level pairs the fill the ink sits on
 * with the `--quoll-quote-ink-mix` that level declares — an added depth rule that
 * deepens the fill without its ink step would land here as a sub-AA number.
 */
const PANEL_SELECTORS = [
  { label: "depth-1 (base panel)", selector: ".cm-line.quoll-blockquote" },
  { label: "depth-2 (nested)", selector: ".cm-line.quoll-blockquote-depth-2" },
  { label: "depth-3 (nested)", selector: ".cm-line.quoll-blockquote-depth-3" },
] as const;

/**
 * BOTH halves of every level are READ from the spec, depth-1 included — the point
 * of deriving all three identically is that there is nowhere left to write a
 * hardcode. The base rule declares no `--quoll-quote-ink-mix` today, so depth-1's
 * is `undefined` and QUOTE_INK's inline `90%` fallback is what renders; writing
 * that `undefined` in by hand would look equivalent and is not. Depth-1 is the one
 * level that can silently disagree with theme.ts, and the disagreement runs the
 * WRONG way: a declared mix weights descriptionForeground higher, i.e. lighter ink
 * and a LOWER ratio, while a hardcoded level would keep measuring 90% and report
 * green against a panel the browser paints sub-AA.
 *
 * `spec` is a parameter rather than a closed-over constant so that read can be
 * observed — with today's spec the two implementations are indistinguishable.
 */
function panelLevels(spec: Record<string, Record<string, string>>): PanelLevel[] {
  return PANEL_SELECTORS.map(({ label, selector }) => ({
    label,
    fill: spec[selector]?.backgroundColor,
    inkMix: spec[selector]?.["--quoll-quote-ink-mix"],
  }));
}

const PANEL_LEVELS = panelLevels(blockSpec);

/**
 * The ratio a reader sees for quoted prose at one panel level under one palette.
 * The ink is composited over the panel and the panel over the editor canvas,
 * because WCAG contrast is defined on COMPOSITED colours and both the HC surface
 * fill and three of the four `descriptionForeground` values carry alpha —
 * treating those as opaque would report a ratio nobody sees, on exactly the token
 * this check is about.
 */
function quoteInkRatio(themeKind: string, level: PanelLevel): number {
  const vars = new Map(varsFor(themeKind));
  vars.set("--quoll-surface-fill", surfaceFillFor(themeKind));
  if (level.inkMix !== undefined) {
    vars.set("--quoll-quote-ink-mix", level.inkMix);
  }
  if (level.fill === undefined) {
    // Name the LEVEL, not the themeKind: the fill comes from blockStyleThemeSpec,
    // which is keyed by CM selector and has no themeKind dimension at all, so a
    // per-palette message would send the next reader off to the palette table for a
    // selector that vanished from theme.ts.
    throw new Error(
      "quote-ink contrast: blockStyleThemeSpec declares no backgroundColor for " +
        `${level.label ?? "(unlabelled level)"} — check the .cm-line.quoll-blockquote* ` +
        "selectors in src/webview/cm/theme.ts"
    );
  }
  const canvas = resolveColor("var(--vscode-editor-background)", vars);
  const panel = compositeOver(resolveColor(level.fill, vars), canvas);
  const ink = compositeOver(resolveColor(QUOTE_INK, vars), panel);
  return contrastRatio(ink, panel);
}

const THEME_KINDS: string[] = Object.keys(PALETTES);

describe("quote ink resolves above the AA floor on every shipped palette (A11Y-14)", () => {
  it("measures the ONE formula both use sites carry", () => {
    // The `t.quote` span paints essentially all visible quoted text and the
    // `.cm-line.quoll-blockquote` rule paints the rest (rationale: QUOTE_INK in
    // theme.ts). They are one constant in source; asserting they are still equal is
    // what lets every ratio below be computed from a single string.
    expect(QUOTE_INK).toContain("color-mix(");
    expect(BASE_RULE?.color).toBe(QUOTE_INK);
    // …and that QUOTE_INK is the colour that WINS on quoted links and headings,
    // which rides on nothing but this array's ORDER. @lezer/highlight concatenates
    // an inherited tag class onto the node's OWN class and emits ONE span (so there
    // is no ancestor/descendant cascade to appeal to), and HighlightStyle.define
    // emits its rules in spec order with LATER entries taking precedence. Move
    // `t.quote` off the end and the accent tokens repaint quoted links: light
    // depth-3 `--quoll-accent-green` on that panel measures 3.99:1, sub-AA, and
    // every generated case below stays green because they only resolve QUOTE_INK.
    expect(quollHighlightSpec.at(-1)?.tag).toBe(t.quote);
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
    // The forms that PARSE into a wrong number are the dangerous ones, because no
    // finiteness check catches them: percentage channels come back on the 0-100
    // scale instead of 0-255, and a `50%` alpha comes back as 50, which
    // compositeOver would happily multiply through.
    expect(() => resolveColor("rgb(50%, 50%, 50%)", new Map())).toThrow(
      /unsupported rgb\(\) component/
    );
    expect(() => resolveColor("rgba(0, 0, 0, 50%)", new Map())).toThrow(
      /unsupported rgb\(\) component/
    );
    expect(() => resolveColor("rgba(0, 0, 0, 1.5)", new Map())).toThrow(/alpha 1.5 outside 0\.\.1/);
    expect(() => resolveColor("rgb(0, 0)", new Map())).toThrow(
      /expected 3 or 4 rgb\(\) components/
    );
    // A two-percentage color-mix() also scales the RESULT alpha by sum/100, which
    // this slice does not model — reject rather than return the normalised-only
    // (wrong) alpha.
    expect(() =>
      resolveColor("color-mix(in srgb, #ffffff 20%, transparent 20%)", new Map())
    ).toThrow(/do not sum to 100%/);
    // Source-over here is the short form that assumes an opaque backdrop, and both
    // backdrops come from data rather than from construction.
    expect(() =>
      compositeOver({ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 0.5 })
    ).toThrow(/translucent backdrop/);
  });
});

describe("the inputs are read from source, not restated", () => {
  it("reads every panel level's fill AND ink mix off the theme spec, depth-1 included", () => {
    // Today's base rule declares no `--quoll-quote-ink-mix`, so a hardcoded
    // `undefined` and a real read are indistinguishable against the shipped spec —
    // which is exactly what makes the hardcode dangerous. Feed a spec that DOES
    // declare one: only a real read carries it through.
    const withBaseMix = {
      ...blockSpec,
      ".cm-line.quoll-blockquote": { ...BASE_RULE, "--quoll-quote-ink-mix": "55%" },
    };
    expect(panelLevels(withBaseMix)[0]?.inkMix).toBe("55%");
    // And the shipped spec still yields no depth-1 mix, i.e. the `90%` fallback in
    // QUOTE_INK is what the base panel actually renders (the A11Y-13 mechanism).
    expect(PANEL_LEVELS[0]?.inkMix).toBeUndefined();
    expect(PANEL_LEVELS.map((level) => level.fill)).not.toContain(undefined);
  });

  it("names the missing SELECTOR, not the palette, when a level loses its fill", () => {
    // The fill is keyed by CM selector with no themeKind dimension, so a message
    // naming the palette would send the reader to the wrong file.
    expect(() => quoteInkRatio("light", { label: "depth-9 (synthetic)" })).toThrow(
      /depth-9 \(synthetic\)/
    );
    expect(() => quoteInkRatio("light", { label: "depth-9 (synthetic)" })).toThrow(
      /quoll-blockquote/
    );
  });

  it("fails loudly when quollHighlightSpec loses the entry it is measuring", () => {
    // `t.comment` is not in the spec, standing in for a removed or renamed
    // `t.quote`. Without this the colour would become the STRING "undefined" and
    // the run would go red inside the resolver instead of here.
    expect(() => specColor(t.comment, "t.comment")).toThrow(/declares no string color/);
  });

  it("rejects a palette table that would silently degrade into CSS fallbacks", () => {
    // Both holes lead to the same place: resolveVar cannot distinguish "token
    // absent" from "token present but unusable", so it takes the fallback arm and
    // measures QUOTE_INK's literal #616161 on #000 — a colour no host renders.
    expect(() =>
      varsFor("synthetic", { descriptionForeground: "#717171", "editor-foreground": "#000000" })
    ).toThrow(/is missing editor-background/);
    expect(() =>
      varsFor("synthetic", {
        descriptionForeground: "#717171",
        "editor-foreground": "#000000",
        "editor-background": 0xffffff,
      })
    ).toThrow(/is number, not a colour string/);
  });
});
