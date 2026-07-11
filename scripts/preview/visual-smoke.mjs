// Driven-Chromium visual smoke for the Quoll webview (dev-only, zero new deps).
//
// `pnpm smoke:visual` builds the REAL webview bundle, serves it through the
// preview harness on an ephemeral port, drives headless Chromium (playwright —
// already a devDependency) to load the combined smoke fixture, screenshots the
// render in light + dark, and asserts one DOM/getComputedStyle check per
// construct (frontmatter, table, task checkboxes, allowlisted vs `javascript:`
// image, fenced code + collapse, theme). It automates the RENDER-APPEARANCE half
// of the manual visual smoke; the editing/round-trip half (typing, save,
// byte-identity, CRLF, caret reveal toggle) still needs the real VS Code host
// and stays in the HUMAN smoke entry (.claude/docs/TODO.md).
//
// Failure model (single source of truth for the exit code): in-page assertions
// NEVER throw for a missing construct — they null-check and return
// { name, pass, msg }. Thrown navigation / timeout / evaluate errors are caught
// in Node and converted to the same { pass:false } shape. The aggregate array
// decides the exit code, evaluated only AFTER all cleanup (finally) has run.

import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { buildWebviewBundle, createPreviewServer } from "./serve.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const fixturePath = resolve(__dirname, "fixtures/visual-smoke.md");
const outDir = resolve(repoRoot, "artifacts/visual-smoke");

const THEMES = ["light", "dark"];

// A 1x1 transparent PNG, used to fulfil the fixture's allowlisted image request
// locally. The live-image check asserts the <img> element + its https src (not
// that the pixels painted), so serving a stub keeps the smoke deterministic and
// offline-safe — a real fetch to example.com would stall/flake on a firewalled
// or offline clean checkout (exactly the "one command from a clean checkout"
// path this harness exists for).
const STUB_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

// Listen on an ephemeral OS-assigned port (0) bound to loopback — avoids the
// fixed 4599 collision (and any lsof/kill restart prompt) entirely.
function listenEphemeral(server) {
  return new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((res) => server.close(() => res()));
}

// Runs inside the page. Returns { name, pass, msg }[] — one entry per construct.
// Pure DOM/getComputedStyle; never throws on a missing element (that would break
// the aggregation model). `theme` is passed so the theme check is self-describing.
function assertInPage(theme) {
  const results = [];
  const add = (name, pass, msg) => results.push({ name, pass, msg });
  const text = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

  // 1. Frontmatter → read-only metadata block rendering the seeded fields
  //    (assert the title value is actually shown, not just that a block exists —
  //    a bare presence + display check would pass on any rendered element).
  const fm = document.querySelector(".quoll-frontmatter-block");
  const fmText = text(fm);
  add(
    "frontmatter",
    !!fm && getComputedStyle(fm).display !== "none" && fmText.includes("smoke test"),
    fm
      ? `frontmatter block text="${fmText}" (want it to contain the title "smoke test")`
      : ".quoll-frontmatter-block not found"
  );

  // 2. Table → rendered <table>; the escaped `\|` stays inside ONE cell.
  const table = document.querySelector(".quoll-table-block table");
  if (!table) {
    add("table", false, ".quoll-table-block table not found");
  } else {
    const rows = [...table.querySelectorAll("tr")];
    const pipeRow = rows.find((r) => /x\\?\|y/.test(text(r)));
    const cellCount = pipeRow ? pipeRow.querySelectorAll("td,th").length : 0;
    add(
      "table",
      rows.length >= 3 && !!pipeRow && cellCount === 2,
      `rows=${rows.length} pipeRow=${!!pipeRow} pipeRowCells=${cellCount} (want rows>=3, escaped pipe in a 2-cell row)`
    );
  }

  // 3. Task checkboxes → exactly two, one checked one not.
  const boxes = [...document.querySelectorAll('.quoll-task-checkbox[role="checkbox"]')];
  const checked = boxes.filter((b) => b.getAttribute("aria-checked") === "true").length;
  const unchecked = boxes.filter((b) => b.getAttribute("aria-checked") === "false").length;
  add(
    "task-checkboxes",
    boxes.length === 2 && checked === 1 && unchecked === 1,
    `count=${boxes.length} checked=${checked} unchecked=${unchecked} (want 2 / 1 / 1)`
  );

  // 4. Allowlisted image → a live <img> with the https src.
  const liveImg = document.querySelector(".quoll-image-block img.quoll-image");
  add(
    "live-image",
    !!liveImg && (liveImg.getAttribute("src") ?? "").startsWith("https://example.com"),
    liveImg
      ? `live <img> src=${liveImg.getAttribute("src")}`
      : "no .quoll-image-block img.quoll-image found"
  );

  // 5a. Security: NO <img> ever carries a javascript: src.
  const jsImg = document.querySelector('img[src^="javascript:"]');
  add(
    "no-js-image",
    !jsImg,
    jsImg ? "FOUND an img[src^=javascript:] — render gate leaked" : "no javascript: <img>"
  );

  // 5b. The blocked image renders an inert placeholder with no src.
  const blocked = document.querySelector(".quoll-image-blocked");
  add(
    "inert-placeholder-present",
    !!blocked && !blocked.hasAttribute("src"),
    blocked
      ? "inert .quoll-image-blocked placeholder present (no src)"
      : ".quoll-image-blocked not found"
  );

  // 6. Fenced code → rendered block with a collapse bar.
  const fence = document.querySelector(".quoll-fenced-code");
  const bar = document.querySelector(".quoll-fenced-collapse-bar");
  add("fenced-code", !!fence && !!bar, `fence=${!!fence} collapseBar=${!!bar} (want both)`);

  // 7. Theme → the shell toggled the matching class on <html>.
  const html = document.documentElement;
  const themeClass = theme === "dark" ? "dark-theme" : "light-theme";
  add(
    `theme-${theme}`,
    html.classList.contains(themeClass),
    `<html> classes=[${[...html.classList].join(" ")}] want ${themeClass}`
  );

  return results;
}

async function run() {
  await mkdir(outDir, { recursive: true });
  await buildWebviewBundle();
  const content = await readFile(fixturePath, "utf8");

  const results = [];
  const screenshots = [];
  const browser = await chromium.launch({ headless: true });
  try {
    for (const theme of THEMES) {
      // Created inside the try so a throw from listen/newPage still hits the
      // finally that closes them — nothing leaks and both themes are attempted.
      let server = null;
      let page = null;
      try {
        server = createPreviewServer({
          override: { theme, content, variations: [{ label: "smoke", css: "" }] },
        });
        const port = await listenEphemeral(server);
        page = await browser.newPage({ viewport: { width: 900, height: 1200 } });
        // Stub the fixture's allowlisted image so navigation never waits on a
        // real network fetch (see STUB_PNG). Must be routed before goto.
        await page.route("https://example.com/**", (route) =>
          route.fulfill({ status: 200, contentType: "image/png", body: STUB_PNG })
        );

        await page.goto(`http://127.0.0.1:${port}/instance?v=0`, { waitUntil: "load" });
        // Deterministic mount signals: CM content, then a real block widget.
        await page.waitForSelector(".cm-content", { timeout: 15000 });
        await page.waitForSelector(".quoll-table-block", { timeout: 15000 });

        const shot = resolve(outDir, `${theme}.png`);
        await page.screenshot({ path: shot, fullPage: true });
        screenshots.push(shot);

        results.push(...(await page.evaluate(assertInPage, theme)));

        // Fence collapse — light run only. The long fence is collapsed by
        // default (empty expanded set, caret not inside it), so clicking the
        // toggle button must FLIP the -collapsed class. Assert the state
        // actually changed (a no-op click or an unconditionally-present bar
        // both fail) rather than reading a class that was already there.
        if (theme === "light") {
          const collapsedSel = ".quoll-fenced-collapse-bar-collapsed";
          const collapsedBefore = (await page.$(collapsedSel)) !== null;
          const toggleBtn = await page.$(".quoll-fenced-collapse-toggle");
          if (!toggleBtn) {
            results.push({
              name: "fence-collapse",
              pass: false,
              msg: "no .quoll-fenced-collapse-toggle button found",
            });
          } else {
            await toggleBtn.click();
            let collapsedAfter = collapsedBefore;
            try {
              // The toggle dispatches a StateEffect → re-render; wait for the
              // class to flip rather than reading it racily right after click.
              await page.waitForFunction(
                ([sel, was]) => (document.querySelector(sel) !== null) !== was,
                [collapsedSel, collapsedBefore],
                { timeout: 5000 }
              );
              collapsedAfter = !collapsedBefore;
            } catch {
              collapsedAfter = (await page.$(collapsedSel)) !== null;
            }
            results.push({
              name: "fence-collapse",
              pass: collapsedAfter !== collapsedBefore,
              msg: `toggle flipped fence collapsed ${collapsedBefore} -> ${collapsedAfter} (want a flip)`,
            });
            const shot2 = resolve(outDir, "fence-toggled.png");
            await page.screenshot({ path: shot2, fullPage: true });
            screenshots.push(shot2);
          }
        }
      } catch (err) {
        // Convert any thrown navigation/timeout/evaluate error into a named
        // failure so BOTH themes are attempted and the failure is loud+named.
        results.push({ name: `theme=${theme} setup`, pass: false, msg: err.message });
      } finally {
        // Guard page.close() so a rejection never skips the server close (leak)
        // or aborts the remaining theme — closeServer already never rejects.
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

  const failures = results.filter((r) => !r.pass);
  console.log(`\n  Quoll visual smoke — ${results.length} checks, ${failures.length} failed\n`);
  for (const r of results) {
    console.log(`  ${r.pass ? "✅" : "❌"} ${r.name}: ${r.msg}`);
  }
  console.log("\n  Screenshots:");
  for (const s of screenshots) {
    console.log(`    ${s}`);
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
