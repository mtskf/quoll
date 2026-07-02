import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("styles.css — decoration reveal class (C4a)", () => {
  const css = readFileSync(new URL("../../src/webview/styles.css", import.meta.url), "utf8");

  it("declares .quoll-syntax-reveal with opacity 0.4 (dim, theme-following)", () => {
    expect(css).toMatch(/\.quoll-syntax-reveal\s*\{[^}]*opacity\s*:\s*0\.4[^}]*\}/);
  });

  it("uses --vscode-descriptionForeground as the dim colour", () => {
    expect(css).toMatch(/\.quoll-syntax-reveal[^}]*var\(--vscode-descriptionForeground/);
  });

  it("does NOT set display:none (the reveal must remain CLICKABLE for caret placement)", () => {
    expect(css).not.toMatch(/\.quoll-syntax-reveal[^}]*display\s*:\s*none/);
  });

  it("does NOT set pointer-events:none (must stay clickable)", () => {
    expect(css).not.toMatch(/\.quoll-syntax-reveal[^}]*pointer-events\s*:\s*none/);
  });
});

describe("styles.css — block-widget margin invariant (CL)", () => {
  const css = readFileSync(new URL("../../src/webview/styles.css", import.meta.url), "utf8");

  // The `quoll-block` marker class is the DOM hook (pinned in
  // cm-table-widget.test.ts); this pins the CSS half — the load-bearing
  // `margin: 0` rule itself. CodeMirror measures block-widget height via
  // getBoundingClientRect() (which excludes margin), so any margin on a
  // quoll-block root reintroduces a click→caret offset for every line
  // below it. A refactor that dropped this rule would leave the DOM marker
  // test green while silently regressing the invariant — this assertion
  // reds instead. (`.quoll-block` is matched literally, so it never hits
  // `.quoll-table-block`.)
  it("declares .quoll-block { margin: 0 } (block-widget zero-margin measurement invariant)", () => {
    expect(css).toMatch(/\.quoll-block\s*\{[^}]*margin\s*:\s*0[^}]*\}/);
  });
});

describe("styles.css — list hang-indent token (LH)", () => {
  const css = readFileSync(new URL("../../src/webview/styles.css", import.meta.url), "utf8");

  it("defines --quoll-task-marker-width (checkbox column width for task-list hang)", () => {
    expect(css).toMatch(/--quoll-task-marker-width\s*:\s*[^;]+;/);
  });
});

describe("styles.css — task-checkbox checkmark is a text-indent-immune border tick", () => {
  const css = readFileSync(new URL("../../src/webview/styles.css", import.meta.url), "utf8");

  // Regression guard for the "checked box renders filled but with NO visible
  // checkmark" bug. A task line renders as `.cm-line.quoll-list-hang`, which
  // carries a NEGATIVE `text-indent` (cm/decorations/list-hang-indent.ts) to
  // pull the marker into the bullet column. That `text-indent` INHERITS into
  // the inline-block `.quoll-task-checkbox` widget. The ORIGINAL checkmark was
  // a `::after { content: "✓" }` GLYPH — text content, so the inherited indent
  // shifted it left OUT of the box onto the editor background where the dark
  // glyph was invisible (the filled box read as "checked-but-blank").
  //
  // The fix redraws the checkmark as a content-less border "tick" (`content:
  // ""`, absolutely positioned by left/top, the ✓ formed by right+bottom
  // borders rotated 45°). Being empty and absolutely positioned, it is IMMUNE
  // to the inherited text-indent (verified in a real browser: the tick stays
  // centred even when the box inherits the line's -21px indent).
  //
  // This is a SOURCE-CONTRACT assertion, not a DOM/computed-style one: the
  // happy-dom integration tests assert `data-checked="true"` (the decoration
  // is correct) and stay GREEN even with the glyph displaced — happy-dom does
  // no layout and drops the calc-based negative text-indent, so it cannot
  // render the displacement. The visual proof is a real-browser smoke; this is
  // the CI guard. Non-vacuous: against the old glyph rule (`content: "✓"`, no
  // border) BOTH assertions below red.
  const afterRule = css.match(/\.quoll-task-checkbox\[data-checked="true"\]::after\s*\{([^}]*)\}/);

  it("draws the checked checkmark as a content-less ::after (a shape, not a glyph)", () => {
    expect(afterRule).not.toBeNull();
    expect(afterRule?.[1]).toMatch(/content\s*:\s*""/);
  });

  it("forms the ✓ with em-scaled RIGHT+BOTTOM-only borders (the tick shape)", () => {
    // `0 <em> <em> 0` = top/left zero, right/bottom set → the two strokes that
    // form a checkmark when rotated 45°. A bare `border-width: <em>` (all four
    // sides) would draw a rotated square, not a tick.
    expect(afterRule?.[1]).toMatch(/border-width\s*:\s*0\s+[\d.]+em\s+[\d.]+em\s+0/);
  });

  it("absolutely positions + centres the tick (what makes it immune to inherited text layout)", () => {
    // The text-indent immunity comes from the tick being absolutely positioned
    // by left/top rather than flowing as text. Codex review #207: pinning only
    // `content: ""` + a border lets a regression that drops the positioning
    // pass — so pin the positioning too.
    expect(afterRule?.[1]).toMatch(/position\s*:\s*absolute/);
    expect(afterRule?.[1]).toMatch(/left\s*:\s*50%/);
    expect(afterRule?.[1]).toMatch(/top\s*:\s*50%/);
  });
});

describe("styles.css — frontmatter metadata block (C8a)", () => {
  const css = readFileSync(new URL("../../src/webview/styles.css", import.meta.url), "utf8");

  it("declares .quoll-frontmatter-block (the metadata block root style)", () => {
    expect(css).toMatch(/\.quoll-frontmatter-block\s*\{/);
  });

  it("declares the two-column .quoll-frontmatter-list grid", () => {
    expect(css).toMatch(/\.quoll-frontmatter-list\s*\{[^}]*grid-template-columns/s);
  });
});

describe("styles.css — navy+green accent token set (palette refresh)", () => {
  const css = readFileSync(new URL("../../src/webview/styles.css", import.meta.url), "utf8");

  const TOKENS = [
    "--quoll-accent-blue",
    "--quoll-accent-green",
    "--quoll-surface-fill",
    "--quoll-surface-header",
    "--quoll-surface-border",
    "--quoll-on-accent",
  ];

  it("defines every accent token under BOTH .dark-theme and .light-theme", () => {
    const dark = css.match(/\.dark-theme\s*\{([^}]*)\}/)?.[1] ?? "";
    const light = css.match(/\.light-theme\s*\{([^}]*)\}/)?.[1] ?? "";
    for (const token of TOKENS) {
      expect(dark, `${token} missing from .dark-theme`).toContain(token);
      expect(light, `${token} missing from .light-theme`).toContain(token);
    }
  });

  it("darkens the DARK selection tint but keeps LIGHT selection the plain host colour", () => {
    const dark = css.match(/\.dark-theme\s*\{([^}]*)\}/)?.[1] ?? "";
    const light = css.match(/\.light-theme\s*\{([^}]*)\}/)?.[1] ?? "";
    // Dark: color-mix that DARKENS (mixes toward #000) the host selection, so it
    // still tracks the user's dark theme rather than hardcoding a hex. Bound the
    // match on `;` (not `)`) so the inner var(...) parens don't truncate it.
    expect(dark).toMatch(
      /--quoll-selection-fill\s*:\s*color-mix\([^;]*--vscode-editor-selectionBackground[^;]*#000/
    );
    // Light: plain host selection colour, unchanged (also covers HC → .light-theme).
    expect(light).toMatch(
      /--quoll-selection-fill\s*:\s*var\(--vscode-editor-selectionBackground\)/
    );
  });

  it("keeps the canvas anchored to --vscode-* (html bg/foreground)", () => {
    expect(css).toMatch(/html\s*\{[^}]*background-color\s*:\s*var\(--vscode-editor-background/s);
    expect(css).toMatch(/html\s*\{[^}]*color\s*:\s*var\(--vscode-editor-foreground/s);
  });

  it("uses no purple/violet hex literals in the accent blocks", () => {
    // Guard the brief's "no purple" requirement against a future retune.
    const dark = css.match(/\.dark-theme\s*\{([^}]*)\}/)?.[1] ?? "";
    const light = css.match(/\.light-theme\s*\{([^}]*)\}/)?.[1] ?? "";
    // Dracula purple family (#bd93f9 etc.) — assert none of our values land there.
    expect(dark.toLowerCase()).not.toMatch(/#(bd93f9|9580ff|6272a4)/);
    expect(light.toLowerCase()).not.toMatch(/#(bd93f9|9580ff|6272a4)/);
  });

  it("neutralises the WHOLE palette to host colours under High Contrast", () => {
    // HC Black/Light both map to .light-theme (host isDarkTheme === Dark only),
    // so without this reset HC Black would paint the light navy palette on a
    // black background. PRIMARY selector is the documented body.vscode-high-contrast
    // class (F1); the reset re-points every accent/surface token to --vscode-*.
    expect(css, "documented HC class selector must be present").toMatch(
      /body\.vscode-high-contrast\b/
    );
    const hc = css.match(/vscode-high-contrast[\s\S]*?\{([\s\S]*?)\}/);
    expect(hc, "HC reset block not found").not.toBeNull();
    const body = hc?.[1] ?? "";
    // Surfaces dropped to transparent (F2: assert the surface fill explicitly)…
    expect(body).toMatch(/--quoll-surface-fill\s*:\s*transparent/);
    // …and EVERY remaining token re-points to a host --vscode-* value.
    for (const token of [
      "--quoll-accent-blue",
      "--quoll-accent-green",
      "--quoll-surface-header",
      "--quoll-surface-border",
      "--quoll-on-accent",
    ]) {
      expect(body, `${token} not reset to a --vscode-* value under HC`).toMatch(
        new RegExp(`${token}\\s*:\\s*[^;]*var\\(--vscode-`)
      );
    }
  });
});

describe("styles.css — widgets consume the accent tokens (palette refresh use sites)", () => {
  const css = readFileSync(new URL("../../src/webview/styles.css", import.meta.url), "utf8");

  it("table header bg uses --quoll-surface-header", () => {
    expect(css).toMatch(/\.quoll-table-block thead th\s*\{[^}]*--quoll-surface-header/s);
  });
  it("table border colour resolves through --quoll-surface-border", () => {
    expect(css).toMatch(/--quoll-table-border\s*:[^;]*--quoll-surface-border/s);
  });
  it("checked task-checkbox fills with --quoll-accent-green", () => {
    expect(css).toMatch(
      /\.quoll-task-checkbox\[data-checked="true"\]\s*\{[^}]*background-color\s*:\s*var\(--quoll-accent-green/s
    );
  });
  it("checked task-checkbox tick uses --quoll-on-accent", () => {
    const after = css.match(/\.quoll-task-checkbox\[data-checked="true"\]::after\s*\{([^}]*)\}/);
    expect(after?.[1]).toMatch(/--quoll-on-accent/);
  });
  it("table links (incl. hover) and table code consume the accent/surface tokens (F3)", () => {
    expect(css).toMatch(/\.quoll-table-block a\s*\{[^}]*color\s*:\s*var\(--quoll-accent-green/s);
    expect(css).toMatch(/\.quoll-table-block a:hover\s*\{[^}]*var\(--quoll-accent-green/s);
    expect(css).toMatch(
      /\.quoll-table-block code\s*\{[^}]*background\s*:\s*var\(--quoll-surface-fill/s
    );
  });
});

describe("styles.css — bullet-list marker token (HC-sensitive)", () => {
  const css = readFileSync(new URL("../../src/webview/styles.css", import.meta.url), "utf8");

  it("defines --quoll-bullet-marker under BOTH .dark-theme and .light-theme", () => {
    const dark = css.match(/\.dark-theme\s*\{([^}]*)\}/)?.[1] ?? "";
    const light = css.match(/\.light-theme\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(dark, "--quoll-bullet-marker missing from .dark-theme").toContain(
      "--quoll-bullet-marker"
    );
    expect(light, "--quoll-bullet-marker missing from .light-theme").toContain(
      "--quoll-bullet-marker"
    );
  });

  it("re-points --quoll-bullet-marker through the host accent under High Contrast (escape hatch)", () => {
    // HC maps to .light-theme; without an explicit override the fixed light green
    // would paint on the HC canvas. Re-point through the (HC-neutralised) accent
    // so the dot stays maximal-contrast. Non-vacuous: dropping the HC override
    // reds this.
    const hc = css.match(/vscode-high-contrast[\s\S]*?\{([\s\S]*?)\}/);
    expect(hc, "HC reset block not found").not.toBeNull();
    expect(hc?.[1] ?? "").toMatch(/--quoll-bullet-marker\s*:\s*var\(--quoll-accent-green/);
  });
});
