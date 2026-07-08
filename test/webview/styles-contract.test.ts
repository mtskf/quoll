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
  // getBoundingClientRect() (which excludes margin), so any VERTICAL margin on a
  // quoll-block root reintroduces a click→caret offset for every line
  // below it. A refactor that dropped this rule would leave the DOM marker
  // test green while silently regressing the invariant — this assertion
  // reds instead. (`.quoll-block` is matched literally, so it never hits
  // `.quoll-table-block`.) HORIZONTAL margin is exempt — the frontmatter card
  // uses it for its text-column inset (compound `.quoll-block.quoll-frontmatter-block`),
  // which this literal `.quoll-block {` match deliberately never touches.
  it("declares .quoll-block { margin: 0 } (block-widget zero-margin measurement invariant)", () => {
    expect(css).toMatch(/\.quoll-block\s*\{[^}]*margin\s*:\s*0[^}]*\}/);
  });
});

describe("styles.css — block-widget roots inset to the paragraph text column", () => {
  const css = readFileSync(new URL("../../src/webview/styles.css", import.meta.url), "utf8");

  // CM's base `.cm-line { padding: 0 2px 0 6px }` insets paragraph text 6px/2px.
  // A block widget fills .cm-content's full content box, so without this reserved
  // inset its box bleeds 6/2 px past the text column. Same transparent-border
  // idiom the blockquote/fenced-code lines use (cm/theme.ts). The 6px/2px is
  // tokenised as --quoll-column-inset-left/-right (:root); pin that the spacer
  // reads the TOKEN so a refactor that drops it (or hardcodes a raw literal back)
  // reds here (real-pixel proof is the browser harness). The token's actual 6px/2px
  // value is pinned by the --quoll-column-inset test below.
  it("gives .quoll-table-block a transparent left/right border from the column-inset token", () => {
    const rule = css.match(/\.quoll-table-block\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(
      /border-left\s*:\s*var\(--quoll-column-inset-left, 6px\) solid transparent/
    );
    expect(rule).toMatch(
      /border-right\s*:\s*var\(--quoll-column-inset-right, 2px\) solid transparent/
    );
  });

  it("gives .quoll-image-block a transparent left/right border from the column-inset token", () => {
    const rule = css.match(/\.quoll-image-block\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(
      /border-left\s*:\s*var\(--quoll-column-inset-left, 6px\) solid transparent/
    );
    expect(rule).toMatch(
      /border-right\s*:\s*var\(--quoll-column-inset-right, 2px\) solid transparent/
    );
  });
});

describe("styles.css — column-inset tokens (mirror of CM's base .cm-line padding)", () => {
  const css = readFileSync(new URL("../../src/webview/styles.css", import.meta.url), "utf8");

  // The single source of truth for the 6px/2px column inset that CM's base
  // `.cm-line { padding: 0 2px 0 6px }` imposes. Every mirror (table/image
  // transparent-border spacers + frontmatter margin here, blockquote/fenced/
  // collapse-bar transparent borders + their elliptical radius compensation in
  // cm/theme.ts) references these tokens instead of a raw literal, so a change to
  // CM's base padding is a one-line retune. This pins the ACTUAL 6px/2px values so
  // the token-reference guards elsewhere stay non-vacuous. The :root declaration is
  // matched inside its own rule body (NOT a whole-file grep) so a comment literal
  // can never satisfy it. Non-vacuous: changing either value here reds.
  it("declares --quoll-column-inset-left: 6px / --quoll-column-inset-right: 2px on :root", () => {
    const root = css.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    expect(root).toMatch(/--quoll-column-inset-left\s*:\s*6px\s*;/);
    expect(root).toMatch(/--quoll-column-inset-right\s*:\s*2px\s*;/);
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
  // carries a NEGATIVE `text-indent` (cm/list/list-hang-indent.ts) to
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

  it("insets .quoll-frontmatter-block with an order-proof horizontal margin (vertical stays 0)", () => {
    // Own-border card can't reuse the transparent-border spacer; inset via a
    // horizontal margin on the COMPOUND selector so it beats `.quoll-block { margin:0 }`
    // by SPECIFICITY (0,2,0), not source order. Vertical margin stays 0 → invariant held.
    const rule = css.match(/\.quoll-block\.quoll-frontmatter-block\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/margin-left\s*:\s*var\(--quoll-column-inset-left, 6px\)/);
    expect(rule).toMatch(/margin-right\s*:\s*var\(--quoll-column-inset-right, 2px\)/);
    expect(rule).not.toMatch(/margin-top/);
    expect(rule).not.toMatch(/margin-bottom/);
    expect(rule).not.toMatch(/margin\s*:/); // no shorthand that could set vertical
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

  it("defines --quoll-completed-fill/--quoll-completed-ink under BOTH themes and re-points fill to host fg under HC", () => {
    const dark = css.match(/\.dark-theme\s*\{([^}]*)\}/)?.[1] ?? "";
    const light = css.match(/\.light-theme\s*\{([^}]*)\}/)?.[1] ?? "";
    for (const token of ["--quoll-completed-fill", "--quoll-completed-ink", "--quoll-todo-ring"]) {
      expect(dark, `${token} missing from .dark-theme`).toContain(token);
      expect(light, `${token} missing from .light-theme`).toContain(token);
    }
    // Light brightens the todo ring to a dedicated green, independent of the link accent.
    expect(light).toMatch(/--quoll-todo-ring\s*:\s*#23b06f/);
    // HC keeps maximal contrast: a solid foreground box (fold-fill precedent) AND full
    // foreground ink (no muting — de-emphasis must not cost HC legibility).
    const hc = css.match(/vscode-high-contrast[\s\S]*?\{([\s\S]*?)\}/)?.[1] ?? "";
    expect(hc).toMatch(/--quoll-completed-fill\s*:\s*var\(--vscode-editor-foreground/);
    expect(hc).toMatch(/--quoll-completed-ink\s*:\s*var\(--vscode-editor-foreground/);
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
  it("table cells draw horizontal rules only (border-bottom, no four-edge grid)", () => {
    // Scope each match to the rule block (selector … `{ … }`) so a matching
    // literal inside a CSS comment cannot vacuate the guard.
    const cellBlock = css.match(/\.quoll-table-block th,\s*\.quoll-table-block td\s*\{([^}]*)\}/);
    expect(cellBlock).not.toBeNull();
    const cellBody = cellBlock?.[1] ?? "";
    // Row rule present …
    expect(cellBody).toMatch(/border-bottom\s*:\s*var\(--quoll-table-border\)/);
    // … and the old four-edge `border:` shorthand is gone (border-bottom/-width
    // survive: `border` is not followed by `:` in those).
    expect(cellBody).not.toMatch(/\bborder\s*:/);
  });
  it("header row carries a stronger 2px rule (Notion-style spine)", () => {
    expect(css).toMatch(/\.quoll-table-block thead th\s*\{[^}]*border-bottom-width\s*:\s*2px/s);
  });
  it("checked task-checkbox fills AND borders with the muted --quoll-completed-fill (NOT accent green — done recedes)", () => {
    expect(css).toMatch(
      /\.quoll-task-checkbox\[data-checked="true"\]\s*\{[^}]*background-color\s*:\s*var\(--quoll-completed-fill/s
    );
    // border-color pin too (a grep for the selector cannot catch a border-color regression).
    expect(css).toMatch(
      /\.quoll-task-checkbox\[data-checked="true"\]\s*\{[^}]*border-color\s*:\s*var\(--quoll-completed-fill/s
    );
  });
  it("checked task-checkbox tick is an editor-background cutout", () => {
    const after = css.match(/\.quoll-task-checkbox\[data-checked="true"\]::after\s*\{([^}]*)\}/);
    expect(after?.[1]).toMatch(/border\s*:\s*solid\s+var\(--vscode-editor-background/);
  });
  it("unchecked task-checkbox leads with the todo-ring green (incomplete dominates)", () => {
    expect(css).toMatch(
      /\.quoll-task-checkbox\s*\{[^}]*border\s*:\s*[\d.]+px\s+solid\s+var\(--quoll-todo-ring/s
    );
  });
  it("task-checkbox box rounds at 5px (the tick's own 0.5px radius is separate)", () => {
    // Pin the BOX corner only — the checkmark tick (`::after`) keeps its own
    // 0.5px radius. Non-vacuous: against the prior 6px this assertion reds.
    expect(css).toMatch(/\.quoll-task-checkbox\s*\{[^}]*border-radius\s*:\s*5px/s);
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

describe("styles.css — thematic break rule", () => {
  const css = readFileSync(new URL("../../src/webview/styles.css", import.meta.url), "utf8");

  it("declares .quoll-thematic-break as a full-width border rule", () => {
    // Matches the rule block and asserts it carries a border-top + width:100%.
    const block = css.match(/\.quoll-thematic-break\s*\{[^}]*\}/);
    expect(block).not.toBeNull();
    expect(block?.[0]).toMatch(/border-top\s*:/);
    expect(block?.[0]).toMatch(/width\s*:\s*100%/);
  });

  it("does NOT set display:none (the rule must be visible)", () => {
    const block = css.match(/\.quoll-thematic-break\s*\{[^}]*\}/);
    expect(block?.[0]).not.toMatch(/display\s*:\s*none/);
  });
});

describe("styles.css — floating-toolbar scroll-hide", () => {
  const css = readFileSync(new URL("../../src/webview/styles.css", import.meta.url), "utf8");

  it("transitions transform on BOTH toggles (so the slide animates, not snaps)", () => {
    expect(css).toMatch(/\.quoll-outline-toggle\s*\{[^}]*transition\s*:[^;]*transform/s);
    expect(css).toMatch(/\.quoll-switch-editor-toggle\s*\{[^}]*transition\s*:[^;]*transform/s);
  });

  it("hides BOTH toggles a11y-safely when the host carries quoll-chrome-hidden", () => {
    // Both toggles share one rule; switch-editor-toggle is the last selector in
    // the list, so match up to its opening brace, then assert the body.
    const body =
      css.match(/\.quoll-chrome-hidden[^{]*\.quoll-switch-editor-toggle\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(css).toMatch(/\.quoll-chrome-hidden\s+\.quoll-outline-toggle/); // outline toggle is in the selector list
    expect(body).toMatch(/transform\s*:\s*translateY\(-/);
    expect(body).toMatch(/opacity\s*:\s*0/);
    expect(body).toMatch(/visibility\s*:\s*hidden/);
    expect(body).toMatch(/pointer-events\s*:\s*none/);
  });

  it("hides the outline panel with the chrome (no detached / focusable panel left floating)", () => {
    const rule =
      css.match(/\.quoll-chrome-hidden\s+\.quoll-outline-panel\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(rule).toMatch(/transform\s*:\s*translateY\(-/);
    expect(rule).toMatch(/opacity\s*:\s*0/);
    expect(rule).toMatch(/visibility\s*:\s*hidden/);
    expect(rule).toMatch(/pointer-events\s*:\s*none/);
  });

  it("disables the slide under prefers-reduced-motion for BOTH base AND hidden (2-class) selectors", () => {
    const mq =
      css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\}\s*\}/)?.[1] ?? "";
    expect(mq).toMatch(/transition\s*:\s*none/);
    // base (1-class) selectors
    expect(mq).toMatch(/\.quoll-outline-toggle/);
    expect(mq).toMatch(/\.quoll-switch-editor-toggle/);
    expect(mq).toMatch(/\.quoll-outline-panel/);
    // hidden (2-class, higher-specificity) selectors MUST also be present, else
    // the MQ can't override the hidden rules and the hide direction still
    // animates (Codex re-review specificity bug).
    expect(mq).toMatch(/\.quoll-chrome-hidden\s+\.quoll-outline-toggle/);
    expect(mq).toMatch(/\.quoll-chrome-hidden\s+\.quoll-switch-editor-toggle/);
    expect(mq).toMatch(/\.quoll-chrome-hidden\s+\.quoll-outline-panel/);
  });
});

describe("styles.css — editor height chain (scroll-hide root cause)", () => {
  const css = readFileSync(new URL("../../src/webview/styles.css", import.meta.url), "utf8");

  // Regression guard for the "floating-toolbar scroll-hide has NO visible
  // effect" bug. The observer (cm/floating-toolbar-scroll.ts) listens for
  // `scroll` on view.scrollDOM (= .cm-scroller) and only stamps
  // `.quoll-chrome-hidden` when THAT element scrolls. But .cm-scroller scrolls
  // internally ONLY if CodeMirror is height-BOUNDED; otherwise .cm-editor grows
  // to its full content height, the whole webview document scrolls
  // (documentElement) and .cm-scroller never fires — so the toggles never hide
  // AND (being absolutely positioned in the now full-height host) they scroll
  // away instead of staying pinned.
  //
  // The bounding is a CSS height chain: .cm-editor → .quoll-editor → main →
  // #root. It collapses to `auto` unless EVERY ancestor carries a DEFINITE
  // height. #root must therefore use `height` (viewport-definite), NOT
  // `min-height` (which is not a definite height for percentage resolution),
  // and `main` must forward `height:100%`. `main` is a `flex-direction: column`
  // stack (banner strip on top, editor below), so the editor host bounds via
  // `flex: 1 1 auto` + `min-height: 0` — a flex-resolved height is definite, so
  // `.cm-editor { height: 100% }` still resolves against it. (Were `main` the
  // default flex ROW, the banner would sit BESIDE the editor, not above it.)
  //
  // SOURCE-CONTRACT assertion, not a computed-style one: the happy-dom
  // ViewPlugin test (cm-floating-toolbar-scroll.test.ts) FORCES a scroll event
  // on .cm-scroller and stayed GREEN through this bug — happy-dom does no
  // layout, so it cannot observe that .cm-scroller is not the real scroller.
  // Behaviourally verified in a real headless-Chrome harness (wheel-down flips
  // quoll-chrome-hidden only AFTER this chain is definite). Non-vacuous:
  // against the pre-fix `#root { min-height: 100vh }` with no `main` height
  // (and `.quoll-editor { height: 100% }`, no flex), all three tests red.
  // Strip CSS comments first: the rule comments here reference sibling links
  // like `.cm-editor { height: 100% }` in prose, and the `[^}]*` block matcher
  // would both truncate at a comment `}` AND leak a commented `height: 100%`
  // into the match (vacuating the `not.toMatch` guards below). Match live CSS.
  const live = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const block = (re: RegExp): string => live.match(re)?.[0] ?? "";
  // `(?<![-a-z])height` matches the `height` property but NOT `min-height` /
  // `max-height` — neither is a definite height for percentage resolution, so a
  // chain link that used one would silently re-open the bug. The lookbehind is
  // load-bearing: `height: 100%` is a substring of `min-height: 100%`, so a
  // plain match would false-pass a regressed rule. EVERY link asserts with it.

  it("#root is exactly the viewport tall (a DEFINITE height, not min-height)", () => {
    const root = block(/#root\s*\{[^}]*\}/);
    expect(root).not.toBe("");
    expect(root).toMatch(/(?<![-a-z])height\s*:\s*100vh/);
  });

  it("main forwards a definite height AND stacks as a column (banner above, not beside)", () => {
    const main = block(/\bmain\s*\{[^}]*\}/);
    expect(main).not.toBe("");
    expect(main).toMatch(/(?<![-a-z])height\s*:\s*100%/);
    // `flex-direction: column` is what puts the banner strip ABOVE the editor.
    // Against the pre-fix default (row) this reds — the banner rendered as a
    // left-hand sibling beside the width:100% editor (the reported bug).
    expect(main).toMatch(/flex-direction\s*:\s*column/);
  });

  it("bounds the .quoll-editor host via flex-fill and keeps .cm-editor at height:100%", () => {
    // In the column stack the host can't use `height:100%` (that would make it
    // as tall as `main`, pushing the editor below the banner and re-opening
    // document scroll). It bounds via `flex: 1 1 auto` + `min-height: 0` — a
    // flex-resolved height is definite, so the `.cm-editor { height: 100% }`
    // link below still resolves and `.cm-scroller` stays the internal scroller.
    const host = block(/\.quoll-editor\s*\{[^}]*\}/);
    expect(host).toMatch(/flex\s*:\s*1\s+1\s+auto/);
    expect(host).toMatch(/min-height\s*:\s*0/);
    // The host must NOT carry a percentage height in the column layout.
    expect(host).not.toMatch(/(?<![-a-z])height\s*:\s*100%/);
    const cmEditor = block(/\.quoll-editor\s+\.cm-editor\s*\{[^}]*\}/);
    expect(cmEditor).toMatch(/(?<![-a-z])height\s*:\s*100%/);
  });
});

describe("styles.css — shared floating-control resting tokens", () => {
  const css = readFileSync(new URL("../../src/webview/styles.css", import.meta.url), "utf8");
  // Strip comments so a token-shaped literal inside a CSS comment can't vacuously
  // satisfy the ":root declares…" match (styles-contract grep vacuation guard).
  const live = css.replace(/\/\*[\s\S]*?\*\//g, "");

  it(":root declares both control tokens (rest opacity + fade)", () => {
    const root = live.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(root).toMatch(/--quoll-control-rest-opacity\s*:\s*[0-9.]+\s*;/);
    expect(root).toMatch(/--quoll-control-transition\s*:\s*opacity\b[^;]*;/);
  });

  it("both corner toggles reference the tokens, not per-control opacity literals", () => {
    for (const sel of [
      /\.quoll-outline-toggle\s*\{[^}]*\}/,
      /\.quoll-switch-editor-toggle\s*\{[^}]*\}/,
    ]) {
      const rule = live.match(sel)?.[0] ?? "";
      expect(rule).not.toBe("");
      expect(rule).toMatch(/opacity\s*:\s*var\(--quoll-control-rest-opacity\)/);
      expect(rule).toMatch(/transition\s*:\s*var\(--quoll-control-transition\)/);
      // The scroll-hide slide leg stays literal alongside the shared opacity leg.
      expect(rule).toMatch(/transition\s*:[^;]*transform/);
      // No bare resting-opacity literal survives on the control itself.
      expect(rule).not.toMatch(/opacity\s*:\s*0\.\d/);
    }
  });
});
