// The ONE ColorThemeKind → wire-ThemeKind mapping site, extracted to its own
// pure module so the unit gate can pin all four kinds directly (the E2E
// round-trip runs outside `pnpm test:unit`). Keeping the mapping here — not
// inlined in quoll-editor-panel.ts — means a regression like HighContrastLight
// silently collapsing to "light" is caught by theme-kind.test.ts, not only in
// E2E. `ColorThemeKind` is the sole vscode touch (a value import for the enum
// members); everything else is pure.

import { ColorThemeKind } from "vscode";
import type { ThemeKind } from "../../shared/protocol.js";

/** Map VS Code's `ColorThemeKind` onto the wire `ThemeKind` — 1:1, no
 *  information loss at the boundary. `HighContrast` is HC *Black* (a dark HC
 *  theme) → `"hc-dark"`; `HighContrastLight` → `"hc-light"`. The webview
 *  collapses both `hc-*` values to a single `.hc-theme` class (display-only
 *  rounding); the host carries the full kind so a future per-HC-kind tune needs
 *  no protocol migration. */
export function themeKindFromColorTheme(kind: ColorThemeKind): ThemeKind {
  switch (kind) {
    case ColorThemeKind.Dark:
      return "dark";
    case ColorThemeKind.HighContrast:
      return "hc-dark";
    case ColorThemeKind.HighContrastLight:
      return "hc-light";
    default:
      return "light"; // ColorThemeKind.Light
  }
}
