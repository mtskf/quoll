// Generates representative Markdown fixtures for manual perf regression
// checks (see .claude/docs/PERF.md). Output lands in the gitignored
// perf-fixtures/ dir — committing a 1 MB markdown blob would bloat the repo,
// and these are reproducible. Open each in the Extension Development Host
// (dev build, QUOLL_PERF on) and read the `[quoll][perf] webview:mount` report.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, "..", "perf-fixtures");
mkdirSync(outDir, { recursive: true });

const PARA = "The quick brown fox jumps over the lazy dog. ".repeat(4);

function prose(targetBytes) {
  let out = "# Performance fixture\n\n";
  let i = 0;
  while (Buffer.byteLength(out, "utf8") < targetBytes) {
    out += `## Section ${i}\n\n${PARA}\n\n- item one\n- item two\n- [a link](https://example.com)\n\n`;
    i += 1;
  }
  return out;
}

function tables(count) {
  let out = "# Table-heavy fixture\n\n";
  for (let t = 0; t < count; t += 1) {
    out += `### Table ${t}\n\n| Col A | Col B | Col C | Col D | Col E |\n| --- | --- | --- | --- | --- |\n`;
    for (let r = 0; r < 10; r += 1) {
      out += `| r${r}a | r${r}b | r${r}c | r${r}d | r${r}e |\n`;
    }
    out += "\n";
  }
  return out;
}

const smallNote = `# A small note

A short paragraph with **bold**, _italic_, and a [link](https://example.com).

- first
- second
- third

> A blockquote for good measure.
`;

const fixtures = {
  "small-note.md": smallNote,
  "doc-100kb.md": prose(100 * 1024),
  "doc-1mb.md": prose(1024 * 1024),
  "table-heavy.md": tables(200),
};

for (const [name, content] of Object.entries(fixtures)) {
  writeFileSync(resolve(outDir, name), content);
  console.log(`wrote ${name} (${(Buffer.byteLength(content, "utf8") / 1024).toFixed(1)} KB)`);
}
