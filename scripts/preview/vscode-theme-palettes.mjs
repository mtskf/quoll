// The four REAL VS Code themeKind palettes for the preview harness.
//
// WHY this is a data module and not four hand-written CSS blocks in the template:
// the harness previously stubbed only `:root` (light) + `html.dark-theme`, which
// meant hc-light and hc-dark silently rendered with the LIGHT palette — the
// a11y probe's High Contrast contrast numbers were a light-theme proxy, not a
// measurement (A11Y-08b). One table per themeKind makes "a themeKind has no
// palette" impossible to express.
//
// PROVENANCE — every HC value is taken verbatim from the installed VS Code build:
//   colorRegistry defaults:
//     <app>/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js
//     (`registerColor(id, { dark, light, hcDark, hcLight })`)
//   Dark High Contrast theme overrides:
//     <app>/Contents/Resources/app/extensions/theme-defaults/themes/hc_black.json
//   (hc_light.json overrides nothing relevant → Light High Contrast is pure registry defaults.)
// Aliases are expanded here (e.g. descriptionForeground = transparent(foreground, 0.7),
// editorWidget.border = contrastBorder under HC) because CSS custom properties are
// a flat namespace — the alias graph lives in the registry, not in the emitted vars.
//
// A token that is DELIBERATELY absent under a themeKind (registry default `null`)
// must be OMITTED, not set to `transparent`: a real host emits no variable at all,
// so the stylesheet's `var(--x, fallback)` fallback is what renders. Reproducing
// the absence is what keeps the harness honest about those fallbacks.
//
// SCOPE: the tables below cover the tokens the template already stubbed, NOT
// every --vscode-* the webview reads. Roughly fifteen tokens (button-secondary*,
// button-hoverBackground, input-*, menu-*, sideBar-background,
// sideBarSectionHeader-foreground, toolbar-activeBackground,
// editor-findMatchBackground, editor-selectionHighlightBackground) are unstubbed
// for every themeKind today and stay that way — each has a working
// var(--x, fallback) at its use site. "Verbatim" describes the provenance of the
// values present, not table completeness.

// Theme-independent: fonts (the nested-list indent is measured at runtime from the
// proportional font's space advance — see prose-space-metric.ts — so these must stay
// realistic) plus nothing else.
const FONTS = {
  "font-family":
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "Ubuntu", "Droid Sans", sans-serif',
  "font-size": "13px",
  "editor-font-family": '"SF Mono", Menlo, Monaco, Consolas, "Courier New", monospace',
};

const LIGHT = {
  foreground: "#616161",
  descriptionForeground: "#717171",
  errorForeground: "#a1260d",
  focusBorder: "#0090f1",
  contrastBorder: "transparent",
  "widget-border": "#d4d4d4",
  "panel-border": "rgba(128, 128, 128, 0.35)",
  "icon-foreground": "#424242",
  "toolbar-hoverBackground": "rgba(184, 184, 184, 0.31)",
  "editor-background": "#ffffff",
  "editor-foreground": "#000000",
  "editor-selectionBackground": "#add6ff",
  "editorCursor-foreground": "#000000",
  "editorError-foreground": "#cd3131",
  "editorWarning-foreground": "#bf8803",
  "editorInfo-foreground": "#1a85ff",
  "editorLineNumber-foreground": "#237893",
  "editorLineNumber-activeForeground": "#0b216f",
  "editorWidget-background": "#f3f3f3",
  "editorWidget-foreground": "#616161",
  "editorWidget-border": "#d4d4d4",
  "editorHoverWidget-background": "#f3f3f3",
  "editorHoverWidget-foreground": "#616161",
  "editorHoverWidget-border": "#c8c8c8",
  "button-background": "#007acc",
  "button-foreground": "#ffffff",
  "list-activeSelectionBackground": "#0060c0",
  "list-activeSelectionForeground": "#ffffff",
  "list-hoverBackground": "#e8e8e8",
  "textLink-foreground": "#006ab1",
  "textLink-activeForeground": "#006ab1",
  "textCodeBlock-background": "#e8e8e8",
  "inputValidation-errorBackground": "#f2dede",
  "inputValidation-warningBackground": "#f6f5d2",
  "charts-blue": "#1a85ff",
  "charts-green": "#388a34",
  "charts-purple": "#652d90",
  "charts-red": "#e51400",
  "charts-yellow": "#bf8803",
  "terminal-ansiGreen": "#00bc00",
  "testing-iconPassed": "#388a34",
  "gitDecoration-addedResourceForeground": "#587c0c",
};

const DARK = {
  ...LIGHT,
  foreground: "#cccccc",
  descriptionForeground: "rgba(204, 204, 204, 0.7)",
  errorForeground: "#f48771",
  focusBorder: "#007fd4",
  "widget-border": "#303031",
  "icon-foreground": "#c5c5c5",
  "toolbar-hoverBackground": "rgba(90, 93, 94, 0.31)",
  "editor-background": "#1e1e1e",
  "editor-foreground": "#d4d4d4",
  "editor-selectionBackground": "#264f78",
  "editorCursor-foreground": "#aeafad",
  "editorError-foreground": "#f14c4c",
  "editorWarning-foreground": "#cca700",
  "editorInfo-foreground": "#3794ff",
  "editorLineNumber-foreground": "#858585",
  "editorLineNumber-activeForeground": "#c6c6c6",
  "editorWidget-background": "#252526",
  "editorWidget-foreground": "#cccccc",
  "editorWidget-border": "#454545",
  "editorHoverWidget-background": "#252526",
  "editorHoverWidget-foreground": "#cccccc",
  "editorHoverWidget-border": "#454545",
  "button-background": "#0e639c",
  "list-activeSelectionBackground": "#094771",
  "list-hoverBackground": "#2a2d2e",
  "textLink-foreground": "#3794ff",
  "textLink-activeForeground": "#3794ff",
  "textCodeBlock-background": "rgba(255, 255, 255, 0.08)",
  "inputValidation-errorBackground": "#5a1d1d",
  "inputValidation-warningBackground": "#352a05",
  "charts-blue": "#3794ff",
  "charts-green": "#89d185",
  "charts-purple": "#b180d7",
  "charts-red": "#f14c4c",
  "charts-yellow": "#cca700",
  "terminal-ansiGreen": "#0dbc79",
  "testing-iconPassed": "#73c991",
  "gitDecoration-addedResourceForeground": "#81b88b",
};

// Dark High Contrast. hc_black.json overrides editor.background/foreground/
// selectionBackground; everything else is the registry hcDark default.
const HC_DARK = {
  foreground: "#FFFFFF",
  descriptionForeground: "rgba(255, 255, 255, 0.7)",
  errorForeground: "#F48771",
  focusBorder: "#F38518",
  contrastBorder: "#6FC3DF",
  "widget-border": "#6FC3DF",
  "panel-border": "#6FC3DF",
  "icon-foreground": "#FFFFFF",
  "editor-background": "#000000",
  "editor-foreground": "#FFFFFF",
  "editor-selectionBackground": "#FFFFFF",
  "editorCursor-foreground": "#FFFFFF",
  "editorError-foreground": "#F48771",
  "editorWarning-foreground": "#FFD370",
  "editorInfo-foreground": "#59A4F9",
  "editorLineNumber-foreground": "#FFFFFF",
  "editorLineNumber-activeForeground": "#F38518",
  "editorWidget-background": "#0C141F",
  "editorWidget-foreground": "#FFFFFF",
  "editorWidget-border": "#6FC3DF",
  "editorHoverWidget-background": "#0C141F",
  "editorHoverWidget-foreground": "#FFFFFF",
  "editorHoverWidget-border": "#6FC3DF",
  "button-background": "#000000",
  "button-foreground": "#FFFFFF",
  "list-hoverBackground": "rgba(255, 255, 255, 0.1)",
  "textLink-foreground": "#21A6FF",
  "textLink-activeForeground": "#21A6FF",
  "textCodeBlock-background": "#000000",
  "inputValidation-errorBackground": "#000000",
  "inputValidation-warningBackground": "#000000",
  "charts-blue": "#59A4F9",
  "charts-green": "#89D185",
  "charts-purple": "#B180D7",
  "charts-red": "#F48771",
  "charts-yellow": "#FFD370",
  "terminal-ansiGreen": "#00CD00",
  "testing-iconPassed": "#73C991",
  "gitDecoration-addedResourceForeground": "#A1E3AD",
};

// Light High Contrast. hc_light.json overrides nothing relevant → pure registry hcLight.
const HC_LIGHT = {
  foreground: "#292929",
  descriptionForeground: "rgba(41, 41, 41, 0.7)",
  errorForeground: "#B5200D",
  focusBorder: "#006BBD",
  contrastBorder: "#0F4A85",
  "widget-border": "#0F4A85",
  "panel-border": "#0F4A85",
  "icon-foreground": "#292929",
  "editor-background": "#FFFFFF",
  "editor-foreground": "#292929",
  "editor-selectionBackground": "#0F4A85",
  "editorCursor-foreground": "#0F4A85",
  "editorError-foreground": "#B5200D",
  "editorWarning-foreground": "#895503",
  "editorInfo-foreground": "#0063D3",
  "editorLineNumber-foreground": "#292929",
  "editorLineNumber-activeForeground": "#006BBD",
  "editorWidget-background": "#FFFFFF",
  "editorWidget-foreground": "#292929",
  "editorWidget-border": "#0F4A85",
  "editorHoverWidget-background": "#FFFFFF",
  "editorHoverWidget-foreground": "#292929",
  "editorHoverWidget-border": "#0F4A85",
  "button-background": "#0F4A85",
  "button-foreground": "#FFFFFF",
  "list-activeSelectionBackground": "rgba(15, 74, 133, 0.1)",
  "list-hoverBackground": "rgba(15, 74, 133, 0.1)",
  "textLink-foreground": "#0F4A85",
  "textLink-activeForeground": "#0F4A85",
  "textCodeBlock-background": "#F2F2F2",
  "inputValidation-errorBackground": "#FFFFFF",
  "inputValidation-warningBackground": "#FFFFFF",
  "charts-blue": "#0063D3",
  "charts-green": "#374E06",
  "charts-purple": "#652D90",
  "charts-red": "#B5200D",
  "charts-yellow": "#895503",
  "terminal-ansiGreen": "#136C13",
  "testing-iconPassed": "#007100",
  "gitDecoration-addedResourceForeground": "#374E06",
};

const PALETTES = { light: LIGHT, dark: DARK, "hc-dark": HC_DARK, "hc-light": HC_LIGHT };

/**
 * The `:root { … }` block for one themeKind. Unknown kinds fall back to light,
 * mirroring serve.mjs's normaliseConfig (an unknown theme must never render an
 * unstyled page).
 */
export function themeVarsCss(themeKind) {
  const palette = PALETTES[themeKind] ?? LIGHT;
  const decls = Object.entries({ ...FONTS, ...palette })
    .map(([token, value]) => `        --vscode-${token}: ${value};`)
    .join("\n");
  return `      :root {\n${decls}\n      }`;
}

/**
 * What the REAL webview host stamps on <body> for this themeKind — the class list
 * plus the data-vscode-theme-kind value (see VS Code's
 * out/vs/workbench/contrib/webview/browser/pre/index.html: it adds the activeTheme
 * class, adds `vscode-high-contrast` alongside `vscode-high-contrast-light` for
 * backwards compatibility, and sets body.dataset.vscodeThemeKind = activeTheme).
 * Quoll's stylesheet keeps `body.vscode-high-contrast*` selectors as
 * defence-in-depth, so the harness must supply them to exercise that path.
 */
export function bodyThemeAttrs(themeKind) {
  switch (themeKind) {
    case "dark":
      return { className: "vscode-dark", themeKind: "vscode-dark" };
    case "hc-dark":
      return { className: "vscode-high-contrast", themeKind: "vscode-high-contrast" };
    case "hc-light":
      return {
        className: "vscode-high-contrast-light vscode-high-contrast",
        themeKind: "vscode-high-contrast-light",
      };
    default:
      return { className: "vscode-light", themeKind: "vscode-light" };
  }
}
