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

/** A `--quoll-*` token's value in the theme block for `themeKind` (exactly one block). */
function themeToken(themeKind: string, token: string): string {
  const selector = THEME_BLOCK[themeKind];
  const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(
    ([, sel, body]) =>
      sel
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split(",")
        .some((part) => part.trim() === selector) && body.includes(`${token}:`)
  );
  expect(blocks, `${token} in "${selector}"`).toHaveLength(1);
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

/** Resolve hex, `var(--vscode-*)` against the palette, and `var(--quoll-*)` against styles.css. */
function resolveColor(expr: string, themeKind: string): Rgb | null {
  const text = expr.trim();
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(text);
  if (hex) {
    return [1, 2, 3].map((i) => Number.parseInt(hex[i], 16)) as Rgb;
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
    return resolveColor(declared, themeKind);
  }
  if (fallback === undefined) {
    throw new Error(`no value and no fallback for ${name}`);
  }
  return resolveColor(fallback, themeKind);
}

const luminance = (c: Rgb): number => {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

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
const toggleRule = collapseToggleThemeSpec[".quoll-fenced-collapse-toggle"] as Record<
  string,
  string | undefined
>;

const CONTROLS = [
  { name: "copy button", rule: copyRule, surface: "--quoll-surface-header", min: 3 },
  { name: "language label", rule: labelRule, surface: "--quoll-surface-header", min: 4.5 },
  { name: "collapse toggle label", rule: toggleRule, surface: "--quoll-surface-fill", min: 4.5 },
];

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
