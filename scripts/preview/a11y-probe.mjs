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
//      order, so tab-order and keyboard-reachability regressions are visible.
//   3. Contrast — WCAG 2.x contrast ratio of each widget's text/affordance against
//      its effective (ancestor-walked) background, per theme. HC themes included.
//
// It is BOTH a report (full inventory to stdout) and a guard: a small set of
// named baseline assertions pin the semantics that are correct today (real
// <button>, role=checkbox + aria-checked, th[scope=col], the copy button's
// standalone aria-live region, etc.) so a future change that strips them fails
// loudly. Contrast is REPORTED with a per-sample pass/flag against the WCAG
// threshold (4.5:1 text, 3:1 non-text UI) but is non-fatal — theme-var resolution
// in a bare browser is not identical to a real VS Code host, so contrast numbers
// inform the audit note rather than gate CI. VoiceOver/announcement behaviour is
// NOT covered here (that is the ⏸ HUMAN half of the audit).
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(__dirname, "fixtures/a11y-audit.md");

// All four themeKinds the wire supports (see serve.mjs THEME_KINDS). hc-* drive
// the standalone `.hc-theme` CSS path — the HC-contrast half of the audit.
const THEMES = ["light", "dark", "hc-light", "hc-dark"];

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
  // WCAG relative luminance + contrast ratio from an "r, g, b" computed color.
  const parseRGB = (s) => {
    const m = /rgba?\(([^)]+)\)/.exec(s || "");
    if (!m) {
      return null;
    }
    const parts = m[1].split(",").map((x) => Number.parseFloat(x.trim()));
    const [r, g, b, a = 1] = parts;
    return { r, g, b, a };
  };
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
  // Effective background: walk ancestors until a non-transparent bg is found;
  // fall back to the document background.
  const effectiveBg = (el) => {
    let node = el;
    while (node && node !== document.documentElement) {
      const bg = parseRGB(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) {
        return bg;
      }
      node = node.parentElement;
    }
    const docBg = parseRGB(getComputedStyle(document.body).backgroundColor);
    return docBg && docBg.a > 0 ? docBg : { r: 255, g: 255, b: 255, a: 1 };
  };
  const contrastOf = (el) => {
    if (!el) {
      return null;
    }
    const cs = getComputedStyle(el);
    const fg = parseRGB(cs.color);
    if (!fg) {
      return null;
    }
    const bg = effectiveBg(el);
    return Math.round(ratio(fg, bg) * 100) / 100;
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
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const ref = document.getElementById(lb);
      if (ref) {
        return (ref.textContent || "").replace(/\s+/g, " ").trim();
      }
    }
    if (el.tagName === "IMG") {
      return el.getAttribute("alt");
    }
    return (el.textContent || "").replace(/\s+/g, " ").trim() || null;
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
          contrast: contrastOf(el),
        }
      : null;

  // --- Semantics inventory: one entry per shipped widget surface. -------------
  const inventory = {
    taskCheckboxes: [...document.querySelectorAll(".quoll-task-checkbox")].map(describe),
    copyButton: describe(document.querySelector(".quoll-copy-button")),
    copyStatusLive: (() => {
      const s = document.querySelector(".quoll-copy-status");
      return s
        ? { ariaLive: s.getAttribute("aria-live"), ariaAtomic: s.getAttribute("aria-atomic") }
        : null;
    })(),
    languagePicker: describe(document.querySelector(".quoll-language-picker")),
    collapseToggle: describe(document.querySelector(".quoll-fenced-collapse-toggle")),
    foldPlaceholder: describe(document.querySelector(".quoll-fold-placeholder")),
    frontmatter: describe(document.querySelector(".quoll-frontmatter-block")),
    liveImage: describe(document.querySelector(".quoll-image-block img.quoll-image")),
    blockedImage: describe(document.querySelector(".quoll-image-blocked")),
    thematicBreak: describe(document.querySelector(".quoll-thematic-break")),
    tableHeaderCells: [...document.querySelectorAll(".quoll-table-block th")].map((th) => ({
      ...describe(th),
      scope: th.getAttribute("scope"),
    })),
    calloutFirstLine: (() => {
      const c = document.querySelector(".cm-line.quoll-callout");
      return c ? { contrast: contrastOf(c) } : null;
    })(),
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
    inventory.languagePicker?.tag === "select" && !!inventory.languagePicker?.name,
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
    inventory.frontmatter?.role === "region" && !!inventory.frontmatter?.name,
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
        await page.goto(`http://127.0.0.1:${port}/instance?v=0`, { waitUntil: "load" });
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
      ["copyButton", t.inventory.copyButton?.contrast, UI_MIN],
      ["collapseToggle", t.inventory.collapseToggle?.contrast, UI_MIN],
      ["languagePicker", t.inventory.languagePicker?.contrast, UI_MIN],
      ["frontmatter", t.inventory.frontmatter?.contrast, TEXT_MIN],
      ["bodyLink", t.inventory.bodyLink?.contrast, TEXT_MIN],
      ["callout", t.inventory.calloutFirstLine?.contrast, TEXT_MIN],
      ["taskCheckbox", t.inventory.taskCheckboxes?.[0]?.contrast, UI_MIN],
    ];
    for (const [name, ratio, min] of contrastSamples) {
      if (ratio == null) {
        console.log(`    ${name}: n/a`);
        continue;
      }
      console.log(`    ${name}: ${ratio}:1  ${ratio >= min ? "✅" : `⚠️ below ${min}:1`}`);
    }
  }

  const failures = allChecks.filter((c) => !c.pass);
  console.log(
    `\n  Baseline semantics checks — ${allChecks.length} run, ${failures.length} failed\n`
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
