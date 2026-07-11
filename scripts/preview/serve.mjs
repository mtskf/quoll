// Zero-dependency real-Chromium preview harness for the Quoll webview.
//
// `pnpm preview [doc.md]` bundles the REAL webview (via the shipped esbuild
// config — no loader/define duplication), serves the exact dist/webview
// artifacts over http, and fills preview.template.html so a plain browser can
// boot the bundle. It exists because ESM `<script src>` will not load from
// file://, and because happy-dom cannot render CSS/widget layout — some bugs
// (e.g. proportional-font-measured indent) only show in a real browser.
//
// Node built-ins + esbuild only (the project's default-deny on new deps). See
// scripts/preview/README.md for usage; edit preview.config.mjs to add
// variations (refresh the browser — the config is re-read per request, so no
// restart is needed).

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { createBuildConfigs } from "../../esbuild.config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const distWebview = resolve(repoRoot, "dist", "webview");
const templatePath = resolve(__dirname, "preview.template.html");

const DEFAULT_PORT = 4599;
const PORT_RETRIES = 10;

function parseArgs(argv) {
  const opts = {
    port: DEFAULT_PORT,
    config: resolve(__dirname, "preview.config.mjs"),
    build: true,
    doc: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? null : arg.slice(eq + 1);
    const nextValue = () => inlineValue ?? argv[++i];
    if (flag === "--no-build") {
      opts.build = false;
    } else if (flag === "--port") {
      opts.port = Number(nextValue());
    } else if (flag === "--config") {
      opts.config = resolve(process.cwd(), nextValue());
    } else if (flag.startsWith("--")) {
      // Ignore unknown flags rather than crash the dev server.
    } else {
      // Positional [doc]: resolve against cwd (a natural CLI path), overriding
      // the config's repo-root-relative `doc` for this run only.
      opts.doc = resolve(process.cwd(), arg);
    }
  }
  return opts;
}

const CONTENT_TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
};

function contentType(filePath) {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Produce a JS string literal safe to embed inside a classic <script>. The
// `<` escape prevents a `</script>` in the markdown from closing the tag;
// U+2028/U+2029 are escaped for older-engine safety.
function jsStringLiteral(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// The only breakout vector inside <style> is a literal `</style`. Escaping the
// slash keeps the CSS parser reading it identically (`\/` === `/`).
function escapeStyle(css) {
  return String(css).replace(/<\/(style)/gi, "<\\/$1");
}

// Same idea for the variation JS injected into the classic <script> body.
function escapeScript(js) {
  return String(js).replace(/<\/(script)/gi, "<\\/$1");
}

function normaliseConfig(cfg) {
  const theme = cfg.theme === "dark" ? "dark" : "light";
  const variations =
    Array.isArray(cfg.variations) && cfg.variations.length > 0
      ? cfg.variations
      : [{ label: "baseline", css: "" }];
  const content = typeof cfg.content === "string" ? cfg.content : "";
  return { theme, variations, content };
}

// Read the config FRESH each request (cache-busted dynamic import) so editing
// preview.config.mjs + refreshing the browser shows new variations without a
// server restart. Resolves the doc content (positional override > cfg.doc file
// > cfg.content inline). When `opts.override` is set (programmatic callers such
// as the visual-smoke harness), it short-circuits the file read so the doc +
// theme can be driven in-memory without a config file.
async function loadConfig(opts) {
  if (opts.override) {
    return normaliseConfig(opts.override);
  }
  const mod = await import(`${pathToFileURL(opts.config).href}?t=${Date.now()}`);
  const cfg = mod.default ?? {};

  // Positional override > cfg.doc file > cfg.content inline.
  let content = typeof cfg.content === "string" ? cfg.content : "";
  const docPath = opts.doc ?? (cfg.doc ? resolve(repoRoot, cfg.doc) : null);
  if (docPath) {
    content = await readFile(docPath, "utf8");
  }
  return normaliseConfig({ ...cfg, content });
}

async function renderInstance(cfg, index) {
  const variation = cfg.variations[index] ?? cfg.variations[0];
  const label = variation.label ?? `variation ${index}`;
  const template = await readFile(templatePath, "utf8");
  return template
    .replaceAll("{{DOC_JSON}}", jsStringLiteral(cfg.content))
    .replaceAll("{{DARK}}", cfg.theme === "dark" ? "true" : "false")
    .replaceAll("{{LABEL}}", escapeHtml(label))
    .replaceAll("{{VARIATION_CSS}}", escapeStyle(variation.css ?? ""))
    .replaceAll("{{VARIATION_JS}}", escapeScript(variation.js ?? ""));
}

function renderGrid(cfg) {
  const cells = cfg.variations
    .map((variation, index) => {
      const label = escapeHtml(variation.label ?? `variation ${index}`);
      return `      <section class="panel">
        <header class="panel-title">${label}</header>
        <iframe src="/instance?v=${index}" title="${label}" loading="lazy"></iframe>
      </section>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Quoll preview — ${cfg.variations.length} variations</title>
    <style>
      html,
      body {
        height: 100%;
        margin: 0;
      }
      body {
        background: #f5f5f5;
        font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(440px, 1fr));
        gap: 12px;
        padding: 12px;
        box-sizing: border-box;
      }
      .panel {
        display: flex;
        flex-direction: column;
        height: 88vh;
        border: 1px solid #d4d4d4;
        border-radius: 6px;
        overflow: hidden;
        background: #ffffff;
      }
      .panel-title {
        padding: 6px 10px;
        font-weight: 600;
        color: #333;
        background: #ececec;
        border-bottom: 1px solid #d4d4d4;
      }
      iframe {
        flex: 1 1 auto;
        width: 100%;
        border: 0;
      }
    </style>
  </head>
  <body>
    <div class="grid">
${cells}
    </div>
  </body>
</html>
`;
}

async function serveStatic(res, pathname) {
  const rel = pathname.slice("/dist/webview/".length);
  const filePath = resolve(distWebview, rel);
  // Contain traversal above dist/webview/.
  if (filePath !== distWebview && !filePath.startsWith(`${distWebview}/`)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }
  if (!existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  const body = await readFile(filePath);
  res.writeHead(200, { "Content-Type": contentType(filePath) });
  res.end(body);
}

// Returns an UNSTARTED http.Server. The `.listen()` call is the caller's job —
// it lives only inside the guarded `main()` below or in an explicit importer
// (the visual-smoke harness). Never bind a port at module top-level, so the
// entrypoint guard stays the sole gate against an accidental server on import.
export function createPreviewServer(opts) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const { pathname } = url;

      if (pathname === "/") {
        const cfg = await loadConfig(opts);
        if (cfg.variations.length > 1) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderGrid(cfg));
        } else {
          res.writeHead(302, { Location: "/instance?v=0" });
          res.end();
        }
        return;
      }

      if (pathname === "/instance") {
        const cfg = await loadConfig(opts);
        const raw = Number(url.searchParams.get("v"));
        const index = Number.isInteger(raw)
          ? Math.min(Math.max(raw, 0), cfg.variations.length - 1)
          : 0;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(await renderInstance(cfg, index));
        return;
      }

      if (pathname.startsWith("/dist/webview/")) {
        await serveStatic(res, pathname);
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Preview error: ${err instanceof Error ? err.stack : String(err)}`);
    }
  });
}

function listen(server, port, retriesLeft) {
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE" && retriesLeft > 0) {
      listen(server, port + 1, retriesLeft - 1);
    } else {
      console.error(err);
      process.exit(1);
    }
  });
  server.listen(port, () => {
    console.log(`\n  Quoll preview → http://localhost:${port}/\n`);
  });
}

// Bundle the REAL webview via the shipped esbuild config (no loader/define
// duplication), so importers (the visual-smoke harness) get a byte-faithful
// dist/webview without shelling out to `pnpm build`.
export async function buildWebviewBundle() {
  const { webviewConfig } = createBuildConfigs({ production: false });
  await esbuild.build(webviewConfig);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.build) {
    await buildWebviewBundle();
  } else if (!existsSync(resolve(distWebview, "index.js"))) {
    console.error(
      "[preview] --no-build set but dist/webview/index.js is missing; build once first."
    );
    process.exit(1);
  }

  listen(createPreviewServer(opts), opts.port, PORT_RETRIES);
}

// Entrypoint guard: only start a server when run directly (`pnpm preview` /
// `node scripts/preview/serve.mjs`), NOT when imported by the visual-smoke
// harness. Pair with the "no top-level .listen()" invariant on createPreviewServer.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
