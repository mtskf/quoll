// Driven-Chromium accessibility probe for the Quoll webview (dev-only, zero new deps).
//
// `pnpm a11y:probe` builds the REAL webview bundle, serves the a11y fixture
// through the preview harness on an ephemeral port, and drives headless Chromium
// (playwright — already a devDependency) across all four themeKinds
// (light / dark / hc-light / hc-dark). For each theme it collects, from the live
// rendered DOM, the three machine-checkable a11y dimensions the audit covers:
//
//   1. Semantics inventory — role (explicit or implicit), accessible name, and
//      state (aria-checked / aria-expanded / aria-live) for every shipped widget
//      affordance. Printed so a reviewer sees exactly what AT would announce.
//   2. Focus order — the focusable elements (native controls + [tabindex]) in DOM
//      order. This is a DOM-order report, not a Tab-driven trace: the focusable
//      selector ignores inert/hidden ancestors and still lists elements (e.g. a
//      tabindex="0" checkbox) whose real reachability via Tab isn't verified
//      here, so it surfaces DOM-order regressions rather than proving keyboard
//      reachability — actual keyboard-driven navigation is the ⏸ HUMAN half.
//   3. Contrast — WCAG 2.x contrast ratio of each widget's CSS text color
//      (`color`) against its effective (ancestor-walked) background, per theme.
//      Both sides are COMPOSITED first: WCAG is defined on composited colours, and
//      VS Code's `descriptionForeground` is `rgba(foreground, 0.7)` in dark and both
//      HC kinds, so treating alpha as opaque would report a ratio the user never
//      sees — on exactly the token this audit is about. Ancestor-accumulated CSS
//      `opacity` is folded in for the same reason (the resting controls render at
//      0.6). Backdrops are `background-color` only: a gradient cannot be rasterised
//      here, so samples with one painted beneath them (detected by hit-test, since
//      the fenced header band is a sibling, not an ancestor) print an explicit
//      caveat rather than a number that looks exact. A SECOND known limit has no
//      detector: accumulated `opacity` is applied to the foreground only, while
//      `effectiveBg` composites ancestor `background-color`s at full strength. CSS
//      composites an `opacity < 1` group — text AND any background layers inside it
//      — as one unit, so the two models agree only while every layer effectiveBg
//      uses lies OUTSIDE every dimmed group. That holds exactly today (all three
//      sampled controls rest on `transparent`, and the one dimming rule,
//      `.quoll-editor.read-only`, is unreachable from this harness — the template
//      hard-codes `canWrite: true`), and it is an invariant nothing enforces.
//      HC themes included. This only measures rendered text color; it cannot
//      assess box/border affordances (e.g. a checkbox's own border), so a
//      sample against such a widget is a text-color proxy, not a true
//      affordance-contrast check (see the taskCheckbox report label).
//
// It is BOTH a report (full inventory to stdout) and a guard: a small set of
// named baseline assertions pin the semantics that are correct today (real
// <button>, role=checkbox + aria-checked, th[scope=col], the copy button's
// standalone aria-live region, etc.) so a future change that strips them fails
// loudly. Contrast is REPORTED with a per-sample pass/flag against the WCAG
// threshold (4.5:1 text, 3:1 non-text UI) and is non-fatal — theme-var resolution
// in a bare browser is not identical to a real VS Code host, so contrast numbers
// inform the audit note rather than gate CI. TWO sets of samples are the exception
// and ARE gated, both because they are shipped a11y remediations whose regression
// this probe exists to notice: the frontmatter card (`frontmatter-text-contrast`,
// A11Y-08) and the four nested quote-ink samples (`nested-quote-text-contrast-*`,
// A11Y-13). Gated HERE still means dev-only — this script does not run in CI.
// VoiceOver/announcement behaviour is NOT covered here (that is the ⏸ HUMAN half
// of the audit).
//
// Failure model mirrors visual-smoke.mjs: in-page collectors never throw on a
// missing element; thrown navigation/evaluate errors are caught in Node and
// converted to a named failure. The aggregate baseline-check array decides the
// exit code, evaluated only after all cleanup has run.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { buildWebviewBundle, createPreviewServer } from "./serve.mjs";
import { THEME_KINDS } from "./vscode-theme-palettes.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(__dirname, "fixtures/a11y-audit.md");

// Every themeKind the harness can render, DERIVED from the palette tables (which
// test/build/theme-palettes.test.ts pins equal to the wire enum) rather than
// hand-copied: this list decides which kinds the fatal contrast gate runs for, so
// a dropped kind would silently narrow the audit with nothing going red. hc-*
// drive the standalone `.hc-theme` CSS path — the HC-contrast half of the audit.
// (Deliberately NOT the same choice as visual-smoke.mjs's THEMES, which is a
// chosen 2-kind subset rather than this enum.)
const THEMES = THEME_KINDS;

const STUB_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

function listenEphemeral(server) {
  return new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res(server.address().port));
  });
}
function closeServer(server) {
  return new Promise((res) => server.close(() => res()));
}

// ---- In-page collector. Pure DOM; returns a plain serialisable object. --------
// Runs inside the page (stringified by playwright), so it may not close over
// Node scope. `theme` is passed for self-describing output.
function collectInPage(theme) {
  // WCAG relative luminance + contrast ratio from a computed color string.
  // Handles both legacy `rgb()/rgba()` and the modern `color(srgb r g b / a)`
  // serialization — Chromium emits the latter for computed `color-mix(in srgb …)`
  // values (e.g. the frontmatter muted-text token), which the rgb-only parser
  // would silently drop to null (an unmeasured, audit-evading text color).
  const parseRGB = (s) => {
    const srgb = /color\(srgb\s+([^)]+)\)/.exec(s || "");
    if (srgb) {
      // Components are 0–1 floats; alpha (after `/`) is optional. Scale to 0–255.
      const [rgb, alpha] = srgb[1].split("/");
      const [r, g, b] = rgb
        .trim()
        .split(/\s+/)
        .map((x) => Number.parseFloat(x) * 255);
      const a = alpha === undefined ? 1 : Number.parseFloat(alpha.trim());
      return { r, g, b, a };
    }
    const m = /rgba?\(([^)]+)\)/.exec(s || "");
    if (!m) {
      return null;
    }
    const parts = m[1].split(",").map((x) => Number.parseFloat(x.trim()));
    const [r, g, b, a = 1] = parts;
    return { r, g, b, a };
  };
  // A regex match is not a parse: `color(srgb 1 0 0 / none)` yields a=NaN and the
  // space-separated `rgb(30 30 30 / 0.5)` form yields undefined g/b. Both are
  // non-null, so a `!c` guard passes them through — the NaN alpha then reads as
  // "fully transparent" and the layer is skipped SILENTLY, which is the exact
  // branch the throws below exist to close.
  const isParsed = (c) => Boolean(c) && [c.r, c.g, c.b, c.a].every(Number.isFinite);
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const lum = ({ r, g, b }) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const ratio = (fg, bg) => {
    const L1 = lum(fg);
    const L2 = lum(bg);
    const [hi, lo] = L1 >= L2 ? [L1, L2] : [L2, L1];
    return (hi + 0.05) / (lo + 0.05);
  };
  // Composite `top` (may be translucent) over the opaque `bottom`. Straight
  // source-over in sRGB — the same operation the compositor performs, which is
  // what WCAG contrast is defined against.
  const over = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  });
  // Does this computed style paint an image (in practice a gradient)? Shared by the
  // two halves of the same known limit — the ancestor walk below and the hit-test in
  // `paintedOverImage` — so both stay on one definition of "an image is involved".
  const hasBgImage = (cs) => Boolean(cs.backgroundImage) && cs.backgroundImage !== "none";
  // Effective background: walk ancestors compositing every translucent layer over
  // the one behind it, stopping at the first OPAQUE layer. A translucent panel over
  // a dark page is not the panel's nominal colour, and treating it as such
  // overstates contrast — the failure mode this whole probe exists to catch.
  // (The walk now includes <html>, which carries a real
  // `background-color: var(--vscode-editor-background)` rule the old
  // stop-at-documentElement loop could never see.)
  //
  // Returns `{ color, ignoredImage }`. `ignoredImage` records the KNOWN LIMIT of
  // this model: only `background-color` participates, so any `background-image`
  // (gradient) on the chain is invisible to it. See `paintedOverImage` below for
  // the other half of the same limit — the backdrop is not always an ancestor.
  const effectiveBg = (el) => {
    const layers = [];
    let ignoredImage = false;
    let node = el;
    while (node) {
      const cs = getComputedStyle(node);
      if (hasBgImage(cs)) {
        ignoredImage = true;
      }
      const raw = cs.backgroundColor;
      const bg = parseRGB(raw);
      if (!isParsed(bg)) {
        // Asymmetric with the foreground path on purpose is what we are FIXING:
        // an unparseable layer used to fall through the same branch as a fully
        // transparent one, yielding a confidently wrong ratio that never reached
        // the exit code. Throw instead — run()'s per-theme catch converts it into
        // a named `setup` failure.
        throw new Error(
          `a11y-probe: unparseable backgroundColor ${JSON.stringify(raw)} on ` +
            `<${node.tagName.toLowerCase()}> while measuring contrast`
        );
      }
      if (bg.a > 0) {
        layers.push(bg);
        if (bg.a >= 1) {
          break;
        }
      }
      node = node.parentElement;
    }
    // Bottom-most opaque canvas: the last layer if it is opaque, else white
    // (a browser's default canvas).
    let composed =
      layers.length > 0 && layers[layers.length - 1].a >= 1
        ? layers.pop()
        : { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) {
      composed = over(layers[i], composed);
    }
    return { color: composed, ignoredImage };
  };
  // Effective element opacity: CSS `opacity` composites the whole element against
  // its backdrop AFTER the text colour is resolved, so a 0.6 control is dimmer than
  // its `color` alone says. It must be accumulated over ANCESTORS, not read off the
  // sampled element: the language picker carries its opacity on the label WRAPPER
  // while the sampled node is the inner <select>
  // (fenced-code-language-picker-widget.ts), so an element-only read misses it.
  const effectiveOpacity = (el) => {
    let acc = 1;
    for (let node = el; node; node = node.parentElement) {
      const o = Number.parseFloat(getComputedStyle(node).opacity);
      acc *= Number.isFinite(o) ? o : 1;
    }
    return acc;
  };
  const rgbStr = (c) => `rgb(${[c.r, c.g, c.b].map((v) => Math.round(v)).join(" ")})`;
  // Is anything painted UNDER this sample a gradient the colour model above cannot
  // see? Hit-test the sample's centre rather than only walking ancestors, because
  // the backdrop is frequently NOT an ancestor: the fenced-code header band is a
  // `linear-gradient` on a SIBLING `.cm-line` (cm/theme.ts) with the copy button /
  // language picker absolutely positioned over it — verified, the ancestor chain
  // for those controls contains no gradient at all. Under HC the band's
  // background-color is additionally `transparent` (styles.css), so the walk
  // composites those controls against the editor canvas instead of the surface the
  // user sees.
  //
  // Rasterising a gradient is out of scope (it needs real pixel sampling). Making
  // the limit VISIBLE on the affected sample is the honest alternative — a
  // silently-wrong ratio is the class of bug this probe exists to expose.
  //
  // Returns true | false | "unknown". The third state is load-bearing:
  // `elementsFromPoint` returns an EMPTY list for a point outside the visual
  // viewport, which is NOT the same answer as "nothing painted here". Reporting it
  // as `false` silently drops the caveat on any sample below the fold — and the
  // ancestor chain does not cover for it, because for this geometry the gradient is
  // on a SIBLING. Today's 1400px viewport leaves the sampled controls ~570px of
  // headroom, so ordinary fixture growth would remove the caveat with nothing going
  // red. A zero-sized rect is left hit-testable on purpose: a degenerate rect still
  // has a valid centre point and hit-tests correctly (measured).
  const paintedOverImage = (el) => {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) {
      return "unknown";
    }
    return document.elementsFromPoint(cx, cy).some((node) => hasBgImage(getComputedStyle(node)));
  };
  // Returns `{ contrast, contrastNote, backdropVerified }`. A null `contrast` means
  // the computed `color` did not parse (live risk — the frontmatter token is a
  // `color-mix()`); the "sample vanished" case is reported by the CALLER, which is
  // the only place that still has the distinction. A non-null contrast may still
  // carry a note, and `backdropVerified` is the STRUCTURED form of it: false
  // whenever the backdrop model is known not to describe what was rendered. Gates
  // read that flag, never the note text, so adding a diagnostic note can never
  // silently turn fatal.
  const measureContrast = (el) => {
    const cs = getComputedStyle(el);
    const fg = parseRGB(cs.color);
    if (!isParsed(fg)) {
      return {
        contrast: null,
        contrastNote: `computed color ${JSON.stringify(cs.color)} did not parse`,
        backdropVerified: false,
      };
    }
    const { color: bg, ignoredImage } = effectiveBg(el);
    const painted = paintedOverImage(el);
    // Text alpha < 1 blends with what is behind the glyph. The muted frontmatter
    // token is exactly this case under dark + both HC kinds (descriptionForeground
    // is rgba(foreground, 0.7) there), so skipping this step reports a contrast the
    // user never sees. Element opacity dims the same way and is folded in here too.
    const alpha = fg.a * effectiveOpacity(el);
    const gradientBeneath = ignoredImage || painted === true;
    let contrastNote = null;
    if (gradientBeneath) {
      contrastNote =
        "measured against backgroundColor only; a gradient painted beneath this sample was ignored";
    } else if (painted === "unknown") {
      contrastNote =
        "backdrop NOT verified — the sample lies outside the viewport, so the hit-test could not " +
        "run; a gradient beneath it would be invisible to this measurement";
    }
    return {
      contrast: Math.round(ratio(over({ ...fg, a: alpha }, bg), bg) * 100) / 100,
      contrastNote,
      backdropVerified: !gradientBeneath && painted === false,
    };
  };

  // The element that actually paints a quote line's prose. CodeMirror wraps
  // highlighted text in generated-class spans, so the reader-visible colour lives
  // on the span, not on the `.cm-line` — and for the nested-quote samples that
  // distinction is the whole point: A11Y-13's mechanism is a custom property
  // declared on the LINE and re-resolved by the SPAN, so measuring the line would
  // confirm the declaration while leaving the inheritance — the part that can
  // actually break — unmeasured. (`calloutFirstLine` below still reads its line;
  // that sample predates this and is a proxy held true by a unit test.)
  //
  // The span is found by a MARKER SUBSTRING from the fixture rather than by "the
  // longest span". Picking by length silently measures whatever happens to be
  // biggest, so a fixture that later grew a long link, emphasis run, or inline code
  // on one of these lines would move the sample onto a differently-coloured element
  // and let a real regression pass while printing a healthy-looking ratio. Returning
  // null when the marker is absent is the fail-loud alternative — the nested-quote
  // gate treats null as a failure, so a fixture edit that breaks a sample is
  // reported rather than absorbed. (This is why those fixture lines must stay free
  // of inline markup: the marker has to land inside one span.)
  const quoteInkSpan = (selector, marker) => {
    const line = document.querySelector(selector);
    if (!line) {
      return null;
    }
    const span = [...line.querySelectorAll("span")].find((s) =>
      (s.textContent || "").includes(marker)
    );
    return span ? measureContrast(span) : null;
  };

  // aria-labelledby is a whitespace-separated IDREF list (ARIA spec), not a
  // single ID — resolve each token and join the referenced elements' text.
  const labelledByText = (el) => {
    const lb = el.getAttribute("aria-labelledby");
    if (!lb) {
      return null;
    }
    const refs = lb
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id))
      .filter(Boolean);
    if (refs.length === 0) {
      return null;
    }
    // A resolved ref list "wins" even if every referenced element's text is
    // empty — callers must distinguish that from "no aria-labelledby" (null).
    return refs
      .map((ref) => (ref.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" ");
  };

  // Accessible name (simplified): aria-label > aria-labelledby text > alt >
  // trimmed textContent. Enough to see what AT would announce for these widgets.
  const accName = (el) => {
    if (!el) {
      return null;
    }
    const label = el.getAttribute("aria-label");
    if (label != null) {
      return label;
    }
    const lbText = labelledByText(el);
    if (lbText !== null) {
      return lbText;
    }
    if (el.tagName === "IMG") {
      return el.getAttribute("alt");
    }
    return (el.textContent || "").replace(/\s+/g, " ").trim() || null;
  };

  // Label-only accessible name: aria-label / aria-labelledby ONLY, no
  // textContent fallback. accName()'s fallback is right for the inventory
  // printout, but wrong for a labelled-guard check on a <select> or a region
  // whose textContent (option text; seeded body) is always non-empty on its
  // own — that fallback would let the guard pass even with aria-label
  // stripped. Used only for the two guards that need to prove a real label.
  const labelOnlyName = (el) => {
    if (!el) {
      return null;
    }
    const label = el.getAttribute("aria-label");
    if (label != null) {
      return label;
    }
    return labelledByText(el) || null;
  };
  const implicitRole = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) {
      return explicit;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "button") {
      return "button";
    }
    if (tag === "a" && el.hasAttribute("href")) {
      return "link";
    }
    if (tag === "select") {
      return "combobox";
    }
    if (tag === "table") {
      return "table";
    }
    if (tag === "th") {
      return "columnheader";
    }
    if (tag === "img") {
      return "img";
    }
    return tag;
  };

  const describe = (el) =>
    el
      ? {
          tag: el.tagName.toLowerCase(),
          role: implicitRole(el),
          name: accName(el),
          tabindex: el.getAttribute("tabindex"),
          ariaChecked: el.getAttribute("aria-checked"),
          ariaExpanded: el.getAttribute("aria-expanded"),
          ...measureContrast(el),
        }
      : null;

  // --- Semantics inventory: one entry per shipped widget surface. -------------
  // Element refs kept for the two baseline guards below that need labelOnlyName.
  const languagePickerEl = document.querySelector(".quoll-language-picker");
  const frontmatterEl = document.querySelector(".quoll-frontmatter-block");
  const inventory = {
    taskCheckboxes: [...document.querySelectorAll(".quoll-task-checkbox")].map(describe),
    copyButton: describe(document.querySelector(".quoll-copy-button")),
    copyStatusLive: (() => {
      const s = document.querySelector(".quoll-copy-status");
      return s
        ? { ariaLive: s.getAttribute("aria-live"), ariaAtomic: s.getAttribute("aria-atomic") }
        : null;
    })(),
    languagePicker: describe(languagePickerEl),
    collapseToggle: describe(document.querySelector(".quoll-fenced-collapse-toggle")),
    foldPlaceholder: describe(document.querySelector(".quoll-fold-placeholder")),
    frontmatter: describe(frontmatterEl),
    liveImage: describe(document.querySelector(".quoll-image-block img.quoll-image")),
    blockedImage: describe(document.querySelector(".quoll-image-blocked")),
    thematicBreak: describe(document.querySelector(".quoll-thematic-break")),
    tableHeaderCells: [...document.querySelectorAll(".quoll-table-block th")].map((th) => ({
      ...describe(th),
      scope: th.getAttribute("scope"),
    })),
    calloutFirstLine: (() => {
      const c = document.querySelector(".cm-line.quoll-callout");
      return c ? measureContrast(c) : null;
    })(),
    // A11Y-13: nested-quote ink, measured on the SPAN (see quoteInkSpan). Four
    // samples because a nested line inside a callout is a different cascade from a
    // plain one — block-style.ts pushes the callout class and the depth class in
    // the same pass, so those lines carry both at equal two-class specificity. The
    // `:not(.quoll-callout)` / `.quoll-callout` split is what stops the two cases
    // aliasing onto whichever happens to come first in the document.
    quoteDepth2: quoteInkSpan(
      ".cm-line.quoll-blockquote-depth-2:not(.quoll-callout)",
      "Depth two plain"
    ),
    quoteDepth3: quoteInkSpan(
      ".cm-line.quoll-blockquote-depth-3:not(.quoll-callout)",
      "Depth three plain"
    ),
    calloutDepth2: quoteInkSpan(
      ".cm-line.quoll-callout.quoll-blockquote-depth-2",
      "Depth two in callout"
    ),
    calloutDepth3: quoteInkSpan(
      ".cm-line.quoll-callout.quoll-blockquote-depth-3",
      "Depth three in callout"
    ),
    outlineToggle: describe(document.querySelector(".quoll-outline-toggle")),
    bodyLink: describe(document.querySelector(".cm-content a")),
  };

  // --- Focus order: focusable elements in DOM order. --------------------------
  const focusableSel = [
    "a[href]",
    "button:not([disabled])",
    "select:not([disabled])",
    "input:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");
  const focusOrder = [...document.querySelectorAll(focusableSel)]
    // Only within the editor + widget surface; skip harness chrome.
    .filter((el) => el.closest(".cm-editor, .quoll-outline-sidebar, .quoll-block"))
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      cls: el.className && typeof el.className === "string" ? el.className.split(/\s+/)[0] : "",
      role: implicitRole(el),
      name: accName(el),
      tabindex: el.getAttribute("tabindex"),
    }));

  // --- Baseline checks (guard rails — these must stay true). ------------------
  const checks = [];
  const add = (name, pass, msg) => checks.push({ theme, name, pass, msg });
  const boxes = inventory.taskCheckboxes;
  add(
    "checkbox-semantics",
    boxes.length >= 1 &&
      boxes.every(
        (b) =>
          b.role === "checkbox" &&
          (b.ariaChecked === "true" || b.ariaChecked === "false") &&
          b.tabindex === "0" &&
          !!b.name
      ),
    `task checkboxes=${JSON.stringify(boxes)}`
  );
  add(
    "copy-button-native-labelled",
    inventory.copyButton?.tag === "button" && !!inventory.copyButton?.name,
    `copyButton=${JSON.stringify(inventory.copyButton)}`
  );
  add(
    "copy-live-region",
    inventory.copyStatusLive?.ariaLive === "polite" &&
      inventory.copyStatusLive?.ariaAtomic === "true",
    `copyStatusLive=${JSON.stringify(inventory.copyStatusLive)}`
  );
  add(
    "language-picker-native-labelled",
    inventory.languagePicker?.tag === "select" && !!labelOnlyName(languagePickerEl),
    `languagePicker=${JSON.stringify(inventory.languagePicker)}`
  );
  add(
    "collapse-toggle-expanded-state",
    inventory.collapseToggle?.tag === "button" &&
      (inventory.collapseToggle?.ariaExpanded === "true" ||
        inventory.collapseToggle?.ariaExpanded === "false"),
    `collapseToggle=${JSON.stringify(inventory.collapseToggle)}`
  );
  add(
    "frontmatter-region-labelled",
    inventory.frontmatter?.role === "region" && !!labelOnlyName(frontmatterEl),
    `frontmatter=${JSON.stringify(inventory.frontmatter)}`
  );
  add(
    "blocked-image-named",
    inventory.blockedImage?.role === "img" && !!inventory.blockedImage?.name,
    `blockedImage=${JSON.stringify(inventory.blockedImage)}`
  );
  add(
    "table-header-scope",
    inventory.tableHeaderCells.length >= 1 &&
      inventory.tableHeaderCells.every((th) => th.scope === "col"),
    `tableHeaderCells=${JSON.stringify(inventory.tableHeaderCells)}`
  );
  // The ONLY contrast sample that is fatal. Every other ratio stays report-only
  // (bare-browser resolution still is not a real host), but the frontmatter card is
  // a SHIPPED a11y remediation (A11Y-08: the muted token was mixed toward
  // editor-foreground to clear AA) and, since the harness now carries the real
  // per-themeKind VS Code palettes (vscode-theme-palettes.mjs), its inputs are
  // authored values rather than a light-theme proxy. A regression here is exactly
  // the thing A11Y-08b was opened to notice.
  //
  // `null` fails too, and it has TWO causes — the sample vanished (reported by the
  // caller-side note below), OR its computed `color` did not parse (a live risk:
  // the token is a `color-mix()`). Those, plus a genuine below-threshold ratio and
  // an unverified backdrop, are four different bugs, so the message below carries
  // `contrastNote` + the measured inputs to tell them apart.
  const frontmatterInputs = (() => {
    if (!frontmatterEl) {
      return "n/a";
    }
    const cs = getComputedStyle(frontmatterEl);
    // Deliberately NOT gated on the foreground parsing: the backdrop is computed
    // independently of `color`, and an unparseable foreground is precisely when a
    // reviewer needs to see what it was being measured against. effectiveBg's throw
    // is the intended fail-loud path and already reaches the exit code.
    const bg = effectiveBg(frontmatterEl).color;
    return `color=${cs.color} effectiveOpacity=${effectiveOpacity(frontmatterEl)} bg=${rgbStr(bg)}`;
  })();
  const frontmatterSample = inventory.frontmatter;
  let frontmatterNote = " [.quoll-frontmatter-block not present in the rendered DOM]";
  if (frontmatterSample) {
    frontmatterNote = frontmatterSample.contrastNote ? ` [${frontmatterSample.contrastNote}]` : "";
  }
  add(
    "frontmatter-text-contrast",
    typeof frontmatterSample?.contrast === "number" &&
      frontmatterSample.contrast >= 4.5 &&
      // An unverified backdrop means the ratio was measured against something other
      // than what rendered. An unreliable input must not green-light the one fatal
      // gate — same rule as null: it is not evidence of passing. Gating on the
      // STRUCTURED flag rather than on note text keeps future diagnostic wording
      // from silently becoming fatal.
      frontmatterSample.backdropVerified,
    `frontmatter contrast=${frontmatterSample?.contrast ?? "n/a"} (AA normal text 4.5:1)` +
      `${frontmatterNote} inputs: ${frontmatterInputs};` +
      ` palette: scripts/preview/vscode-theme-palettes.mjs`
  );
  // The SECOND fatal contrast gate, and fatal for the same reason as the
  // frontmatter card: nested-quote ink is a SHIPPED a11y remediation (A11Y-13 — the
  // depth rules step `--quoll-quote-ink-mix` down alongside the fill), and the
  // defect it fixes is precisely one this probe could NOT see until the fixture
  // gained nested depths. Leaving it report-only would re-open that blind spot on
  // the very code path that was blind.
  //
  // Same gate shape as frontmatter, so the same four bugs stay distinguishable: a
  // null sample (the fixture lost its nested quote, or a marker no longer lands in
  // one span), an unparseable colour, an unverified backdrop (e.g. the block
  // drifted below the fold), and a genuine sub-AA ratio. The message carries each
  // sample's own note + ratio for that reason.
  //
  // This does NOT promote the probe to a CI gate. Fatal-here / cheaper-check-in-CI
  // is the split A11Y-08 already shipped for the frontmatter card, and it applies
  // here for the same reason: this probe needs a real Chromium, so it stays
  // dev-only. The CI half is no longer the same, though — for the frontmatter card
  // CI pins only the FORMULA, whereas since A11Y-14 the quote-ink RATIOS are also
  // computed in `pnpm test:unit` by test/webview/cm-quote-ink-contrast.test.ts,
  // which resolves the same formula over the same palette tables as pure maths and
  // fails under 4.5:1. So this is the precedent applied a second time and
  // strengthened, not merely repeated. The two halves stay complementary rather
  // than redundant — that unit check cannot see the cascade or the DOM, so a rule
  // that stops applying or a span that stops inheriting is still visible ONLY here.
  for (const [label, sample] of [
    ["depth-2", inventory.quoteDepth2],
    ["depth-3", inventory.quoteDepth3],
    ["callout-depth-2", inventory.calloutDepth2],
    ["callout-depth-3", inventory.calloutDepth3],
  ]) {
    let nestedNote = " [no quote-ink span found for this depth in the rendered DOM]";
    if (sample) {
      nestedNote = sample.contrastNote ? ` [${sample.contrastNote}]` : "";
    }
    add(
      `nested-quote-text-contrast-${label}`,
      typeof sample?.contrast === "number" && sample.contrast >= 4.5 && sample.backdropVerified,
      `nested quote ${label} contrast=${sample?.contrast ?? "n/a"} (AA normal text 4.5:1)` +
        `${nestedNote}; palette: scripts/preview/vscode-theme-palettes.mjs`
    );
  }
  add(
    "thematic-break-separator",
    inventory.thematicBreak?.role === "separator",
    `thematicBreak=${JSON.stringify(inventory.thematicBreak)}`
  );

  return { theme, inventory, focusOrder, checks };
}

async function run() {
  await buildWebviewBundle();
  const content = await readFile(fixturePath, "utf8");

  const perTheme = [];
  const allChecks = [];
  const browser = await chromium.launch({ headless: true });
  try {
    for (const theme of THEMES) {
      let server = null;
      let page = null;
      try {
        server = createPreviewServer({
          override: { theme, content, variations: [{ label: "a11y", css: "" }] },
        });
        const port = await listenEphemeral(server);
        page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
        await page.route("https://example.com/**", (route) =>
          route.fulfill({ status: 200, contentType: "image/png", body: STUB_PNG })
        );
        const resp = await page.goto(`http://127.0.0.1:${port}/instance?v=0`, {
          waitUntil: "load",
        });
        // The preview server reports its own failures as a 500 body (serve.mjs's
        // per-request catch). goto() resolves on ANY status, so without this the body
        // — which carries the real cause, e.g. an unmapped themeKind — is discarded
        // and the failure degrades into a 15s selector timeout pointing at
        // CodeMirror. Thrown into the existing per-theme catch as a named `setup`
        // failure; no new try/catch, no change to the documented failure model.
        if (!resp?.ok()) {
          const body = resp ? await resp.text() : "";
          throw new Error(
            `preview server returned ${resp?.status() ?? "no response"}: ${body.slice(0, 500)}`
          );
        }
        await page.waitForSelector(".cm-content", { timeout: 15000 });
        await page.waitForSelector(".quoll-table-block", { timeout: 15000 });

        const data = await page.evaluate(collectInPage, theme);
        perTheme.push(data);
        allChecks.push(...data.checks);
      } catch (err) {
        allChecks.push({ theme, name: "setup", pass: false, msg: err.message });
      } finally {
        if (page) {
          await page.close().catch(() => {});
        }
        if (server) {
          await closeServer(server);
        }
      }
    }
  } finally {
    await browser.close();
  }

  // ---- Report -----------------------------------------------------------------
  const TEXT_MIN = 4.5; // WCAG AA normal text
  const UI_MIN = 3.0; // WCAG AA non-text / large text
  for (const t of perTheme) {
    console.log(`\n================ theme: ${t.theme} ================`);
    console.log("\n  Semantics inventory:");
    for (const [key, val] of Object.entries(t.inventory)) {
      console.log(`    ${key}: ${JSON.stringify(val)}`);
    }
    console.log("\n  Focus order (DOM order):");
    if (t.focusOrder.length === 0) {
      console.log("    (no focusable widget elements found)");
    }
    t.focusOrder.forEach((f, i) => {
      console.log(
        `    ${i + 1}. <${f.tag} .${f.cls}> role=${f.role} name=${JSON.stringify(f.name)} tabindex=${f.tabindex}`
      );
    });
    console.log("\n  Contrast (ratio : threshold flag):");
    const contrastSamples = [
      ["copyButton", t.inventory.copyButton, UI_MIN],
      ["collapseToggle", t.inventory.collapseToggle, UI_MIN],
      ["languagePicker", t.inventory.languagePicker, UI_MIN],
      ["frontmatter", t.inventory.frontmatter, TEXT_MIN],
      ["bodyLink", t.inventory.bodyLink, TEXT_MIN],
      ["callout", t.inventory.calloutFirstLine, TEXT_MIN],
      ["quote depth-2 (nested, span)", t.inventory.quoteDepth2, TEXT_MIN],
      ["quote depth-3 (nested, span)", t.inventory.quoteDepth3, TEXT_MIN],
      ["callout depth-2 (nested, span)", t.inventory.calloutDepth2, TEXT_MIN],
      ["callout depth-3 (nested, span)", t.inventory.calloutDepth3, TEXT_MIN],
      [
        "taskCheckbox (text-color proxy, not box/border affordance)",
        t.inventory.taskCheckboxes?.[0],
        UI_MIN,
      ],
    ];
    // The caveat is printed inline rather than folded into the number: a sample
    // whose backdrop includes an un-rasterised gradient is not a measurement, and
    // silently rounding that away is the class of bug this probe exists to expose.
    for (const [name, sample, min] of contrastSamples) {
      const ratio = sample?.contrast;
      const suffix = sample?.contrastNote ? `  — ${sample.contrastNote}` : "";
      if (ratio == null) {
        console.log(`    ${name}: n/a${suffix}`);
        continue;
      }
      console.log(`    ${name}: ${ratio}:1  ${ratio >= min ? "✅" : `⚠️ below ${min}:1`}${suffix}`);
    }
  }

  const failures = allChecks.filter((c) => !c.pass);
  console.log(
    `\n  Baseline checks (semantics + the frontmatter and nested-quote contrast gates) — ` +
      `${allChecks.length} run, ${failures.length} failed\n`
  );
  for (const c of allChecks) {
    console.log(`  ${c.pass ? "✅" : "❌"} [${c.theme}] ${c.name}: ${c.msg}`);
  }
  console.log("");
  if (failures.length > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
