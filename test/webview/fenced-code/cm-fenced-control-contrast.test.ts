// A11Y-12 — resting contrast of the fenced-code controls, computed in CI.
//
// The copy button and language label float over the header band (a gradient of
// --quoll-surface-header); the collapse toggle's label sits on the collapse bar's
// --quoll-surface-fill. `pnpm a11y:probe` cannot rasterise the header gradient, so
// its copy/picker rows carry a caveat; this file computes the same ratio from source
// instead: the control's colour + resting opacity from the exported theme specs, the
// surface from the shipped styles.css theme blocks, and the --vscode-* values from
// the preview palettes. Same split as cm-quote-ink-contrast.test.ts (that file's
// header explains why a pure-maths model and the browser probe are complementary).
//
// Thresholds: the copy button is icon-only (non-text UI, 3:1); the language label
// and the "Show N more lines" label are normal-size text (4.5:1).
//
// A11Y-16 adds the copy button's success checkmark (`.is-copied`), measured at rest
// and on hover / keyboard focus (both paint toolbar-hoverBackground over the surface),
// on the header band AND the bare-block fill (the button is on every writable block).
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// @ts-expect-error — plain .mjs with no bundled types; vitest transpiles it.
import { PALETTES } from "../../../scripts/preview/vscode-theme-palettes.mjs";
import {
  collapseToggleThemeSpec,
  copyButtonThemeSpec,
  fencedHeaderBarThemeSpec,
} from "../../../src/webview/cm/theme.js";

const css = readFileSync(new URL("../../../src/webview/styles.css", import.meta.url), "utf8");

type Rgb = [number, number, number];

const THEME_BLOCK: Record<string, string> = {
  light: ".light-theme",
  dark: ".dark-theme",
  "hc-light": ":root.hc-theme",
  "hc-dark": ":root.hc-theme",
};

/**
 * A `--quoll-*` token's value in the theme block for `themeKind`: at most one block may
 * declare it, and none means undeclared (the use site's fallback applies).
 */
function themeToken(themeKind: string, token: string): string | undefined {
  const selector = THEME_BLOCK[themeKind];
  const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(
    ([, sel, body]) =>
      sel
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split(",")
        .some((part) => part.trim() === selector) && body.includes(`${token}:`)
  );
  expect(blocks.length, `${token} in "${selector}"`).toBeLessThanOrEqual(1);
  if (blocks.length === 0) {
    return undefined;
  }
  return new RegExp(`${token}:\\s*([^;]+);`).exec(blocks[0][2])?.[1].trim() ?? "";
}

/** The rest opacity a spec value resolves to: absent = 1; the shared token = its :root value. */
function restOpacity(value: string | undefined): number {
  if (value === undefined) {
    return 1;
  }
  if (/^var\(--quoll-control-rest-opacity\b/.test(value)) {
    const root = /--quoll-control-rest-opacity:\s*([\d.]+)\s*;/.exec(css);
    if (!root) {
      throw new Error("no :root --quoll-control-rest-opacity in styles.css");
    }
    return Number.parseFloat(root[1]);
  }
  if (/^[\d.]+$/.test(value)) {
    return Number.parseFloat(value);
  }
  throw new Error(`unmodelled opacity ${JSON.stringify(value)}`);
}

/** Opaque colour plus alpha; only the hover tint is translucent here. */
type Rgba = { rgb: Rgb; a: number };

/**
 * Resolve hex, unitless `rgba()`, `var(--vscode-*)` against the palette, and
 * `var(--quoll-*)` against styles.css. `transparent` is null.
 */
function resolveRgba(expr: string, themeKind: string): Rgba | null {
  const text = expr.trim();
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(text);
  if (hex) {
    return { rgb: [1, 2, 3].map((i) => Number.parseInt(hex[i], 16)) as Rgb, a: 1 };
  }
  const rgba = /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/.exec(text);
  if (rgba) {
    const [r, g, b, a] = rgba.slice(1).map(Number.parseFloat);
    return { rgb: [r, g, b], a };
  }
  if (text === "transparent") {
    return null;
  }
  const call = /^var\((--[\w-]+)\s*(?:,\s*(.*))?\)$/.exec(text);
  if (!call) {
    throw new Error(`unmodelled colour ${JSON.stringify(expr)}`);
  }
  const [, name, fallback] = call;
  const declared = name.startsWith("--vscode-")
    ? (PALETTES[themeKind] as Record<string, string>)[name.slice("--vscode-".length)]
    : themeToken(themeKind, name);
  if (declared !== undefined) {
    return resolveRgba(declared, themeKind);
  }
  if (fallback === undefined) {
    throw new Error(`no value and no fallback for ${name}`);
  }
  return resolveRgba(fallback, themeKind);
}

/** An OPAQUE colour (a control's ink, a surface); a translucent one is unmodelled here. */
function resolveColor(expr: string, themeKind: string): Rgb | null {
  const color = resolveRgba(expr, themeKind);
  if (color !== null && color.a !== 1) {
    throw new Error(`unexpected translucent colour ${JSON.stringify(expr)}`);
  }
  return color?.rgb ?? null;
}

/** WCAG relative luminance of an sRGB colour. */
function luminance(c: Rgb): number {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG ratio of `fg` at element opacity `alpha`, composited source-over onto `bg`. */
function contrast(fg: Rgb, bg: Rgb, alpha: number): number {
  const shown = fg.map((v, i) => alpha * v + (1 - alpha) * bg[i]) as Rgb;
  const [hi, lo] = [luminance(shown), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

/** A surface token, falling through `transparent` (HC) to the editor canvas. */
function surface(token: string, themeKind: string): Rgb {
  const color = resolveColor(`var(${token})`, themeKind);
  return color ?? (resolveColor("var(--vscode-editor-background)", themeKind) as Rgb);
}

const labelRule =
  fencedHeaderBarThemeSpec[
    ".cm-line.quoll-fenced-code-fence-hidden .quoll-language-picker-label.is-labeled, .cm-line.quoll-fenced-code-has-language .quoll-language-picker-label.is-labeled"
  ];
const copyRule = copyButtonThemeSpec[".quoll-copy-button"] as Record<string, string | undefined>;
const caretRule = fencedHeaderBarThemeSpec[
  ".quoll-language-picker-label.is-labeled .quoll-language-picker-caret"
] as Record<string, string | undefined>;
const toggleRule = collapseToggleThemeSpec[".quoll-fenced-collapse-toggle"] as Record<
  string,
  string | undefined
>;

const CONTROLS = [
  { name: "copy button", rule: copyRule, surface: "--quoll-surface-header", min: 3 },
  { name: "language label", rule: labelRule, surface: "--quoll-surface-header", min: 4.5 },
  // The caret's SVG strokes `currentColor`, so it inherits the label's colour; its own
  // opacity composes with the label's (here both absent = 1).
  {
    name: "language caret",
    rule: {
      color: labelRule.color,
      opacity: String(restOpacity(labelRule.opacity) * restOpacity(caretRule.opacity)),
    },
    surface: "--quoll-surface-header",
    min: 3,
  },
  { name: "collapse toggle label", rule: toggleRule, surface: "--quoll-surface-fill", min: 4.5 },
];

const copiedRule = copyButtonThemeSpec[".quoll-copy-button.is-copied"] as Record<
  string,
  string | undefined
>;
const hoverRule = copyButtonThemeSpec[
  ".quoll-copy-button:hover, .quoll-copy-button:focus-visible"
] as Record<string, string | undefined>;

/** The copy button's backdrop: the surface, plus the hover/focus tint composited over it. */
function copyBackdrop(token: string, themeKind: string, hovered: boolean): Rgb {
  const base = surface(token, themeKind);
  if (!hovered) {
    return base;
  }
  // HC hosts emit no toolbar-hoverBackground, so the tint resolves to transparent there.
  const tint = resolveRgba(hoverRule.backgroundColor ?? "", themeKind);
  if (tint === null) {
    return base;
  }
  const { rgb, a } = tint;
  return rgb.map((v, i) => a * v + (1 - a) * base[i]) as Rgb;
}

// A11Y-11 — under High Contrast the hover tint is absent (registry null), so the hover
// affordance is the workbench's dashed toolbar-hoverOutline. Non-text UI → 3:1 against
// every surface the control sits on.
const HOVER_OUTLINE_RULES = [
  {
    name: "copy button",
    key: ".quoll-copy-button:hover:not(:focus-visible)",
    spec: copyButtonThemeSpec,
    surfaces: ["--quoll-surface-header", "--quoll-surface-fill"],
  },
  {
    name: "fenced collapse toggle",
    key: ".quoll-fenced-collapse-toggle:hover:not(:focus-visible)",
    spec: collapseToggleThemeSpec,
    surfaces: ["--quoll-surface-fill"],
  },
  {
    name: "blockquote collapse toggle",
    key: ".quoll-blockquote-collapse-toggle:hover:not(:focus-visible)",
    spec: collapseToggleThemeSpec,
    surfaces: ["--quoll-surface-fill"],
  },
];

describe("fenced-control hover under High Contrast (A11Y-11)", () => {
  for (const { name, key, spec, surfaces } of HOVER_OUTLINE_RULES) {
    const rule = (spec as Record<string, Record<string, string | undefined>>)[key];

    it(`${name}: hover draws the dashed toolbar-hoverOutline`, () => {
      expect(rule?.outline).toBe("1px dashed var(--vscode-toolbar-hoverOutline)");
    });

    for (const themeKind of ["hc-light", "hc-dark"]) {
      for (const token of surfaces) {
        it(`${themeKind}: ${name} hover outline clears 3:1 on ${token}`, () => {
          const ink = resolveColor("var(--vscode-toolbar-hoverOutline)", themeKind) as Rgb;
          expect(contrast(ink, surface(token, themeKind), 1)).toBeGreaterThanOrEqual(3);
        });
      }
    }
  }

  // No invented tint under HC: the host emits no toolbar-hoverBackground there.
  for (const themeKind of ["hc-light", "hc-dark"]) {
    it(`${themeKind}: the hover background is transparent (no invented tint)`, () => {
      expect(resolveRgba(hoverRule.backgroundColor ?? "", themeKind)).toBeNull();
    });
  }

  // Outside HC the token is registry-null, so the outline declaration paints nothing and
  // the toolbar-hoverBackground tint stays the only hover affordance.
  for (const themeKind of ["light", "dark"]) {
    it(`${themeKind}: no hover outline token; the hover tint is the host colour`, () => {
      expect(PALETTES[themeKind]).not.toHaveProperty("toolbar-hoverOutline");
      expect(resolveRgba(hoverRule.backgroundColor ?? "", themeKind)).not.toBeNull();
    });
  }

  // Non-vacuity: the pre-fix literal fallback (white at 10%) on hc-light's white canvas
  // is indistinguishable from the resting button — the A11Y-11 defect.
  it("the pre-fix white 10% tint is invisible on the hc-light canvas", () => {
    const canvas = surface("--quoll-surface-fill", "hc-light");
    const tinted = canvas.map((v) => 0.1 * 255 + 0.9 * v) as Rgb;
    expect(contrast(tinted, canvas, 1)).toBeLessThan(1.1);
  });
});

describe("copy button success checkmark contrast (A11Y-16)", () => {
  for (const themeKind of Object.keys(THEME_BLOCK)) {
    for (const token of ["--quoll-surface-header", "--quoll-surface-fill"]) {
      for (const hovered of [false, true]) {
        const state = hovered ? "hover/focus" : "rest";
        it(`${themeKind}: checkmark clears 3:1 on ${token} at ${state}`, () => {
          const fg = resolveColor(copiedRule.color ?? "", themeKind) as Rgb;
          const ratio = contrast(fg, copyBackdrop(token, themeKind, hovered), 1);
          expect(ratio).toBeGreaterThanOrEqual(3);
        });
      }
    }
  }

  // Dark and both HC kinds keep VS Code's own success colour (only Light overrides it).
  for (const themeKind of ["dark", "hc-light", "hc-dark"]) {
    it(`${themeKind}: checkmark is the host testing-iconPassed`, () => {
      expect(resolveColor(copiedRule.color ?? "", themeKind)).toEqual(
        resolveColor("var(--vscode-testing-iconPassed)", themeKind)
      );
    });
  }

  // Non-vacuity: Light+'s own testing-iconPassed on the hovered header is the A11Y-16 defect.
  it("the host testing-iconPassed fails on the hovered light header (pre-fix state)", () => {
    const fg = resolveColor("var(--vscode-testing-iconPassed)", "light") as Rgb;
    const bg = copyBackdrop("--quoll-surface-header", "light", true);
    expect(contrast(fg, bg, 1)).toBeLessThan(3);
  });
});

describe("fenced-code control resting contrast (A11Y-12)", () => {
  for (const themeKind of Object.keys(THEME_BLOCK)) {
    for (const control of CONTROLS) {
      it(`${themeKind}: ${control.name} clears ${control.min}:1 on ${control.surface}`, () => {
        const fg = resolveColor(control.rule.color ?? "", themeKind);
        expect(fg, "control colour").not.toBeNull();
        const ratio = contrast(
          fg as Rgb,
          surface(control.surface, themeKind),
          restOpacity(control.rule.opacity)
        );
        expect(ratio).toBeGreaterThanOrEqual(control.min);
      });
    }
  }

  // Non-vacuity: the pre-fix shared 0.6 dim on the light header is what A11Y-12 was
  // opened for, and the model must read it as failing.
  it("the shared 0.6 rest dim fails on the light header (pre-fix state)", () => {
    const fg = resolveColor("var(--vscode-foreground)", "light") as Rgb;
    const bg = surface("--quoll-surface-header", "light");
    expect(contrast(fg, bg, restOpacity("var(--quoll-control-rest-opacity, 0.6)"))).toBeLessThan(3);
  });
});
