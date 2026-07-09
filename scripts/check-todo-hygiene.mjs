#!/usr/bin/env node
// scripts/check-todo-hygiene.mjs
//
// Lint .claude/docs/TODO.md against the entry conventions documented in the
// file header, so they stop drifting once documented-but-unenforced.
//
// Why this exists (and why it is a LOCAL script, not a CI job): in this repo
// `.claude/` is git-ignored, so `.claude/docs/TODO.md` does NOT exist in git
// checkouts or CI runners. A GitHub Action reading it would run against a
// missing file. So — exactly like the sibling `check-stale-todo-markers.mjs`
// — this ships as a standalone Node script under scripts/ (which IS tracked)
// plus a `pnpm check:todo-hygiene` entry, run locally. See CLAUDE.md
// § "Merging PRs" for why the TODO file is intentionally absent from git.
//
// The four rule checks are PURE FUNCTIONS over the file text (see the
// `lint*` exports), so they are unit-testable with in-memory fixtures
// regardless of the real TODO's tracked status. `main()` is a thin fs wrapper
// that reads the real TODO for the `pnpm check:todo-hygiene` run.
//
// ─────────────────────────────────────────────────────────────────────────
// RULES (each maps to one exported `lint*` function)
//
//   (1) DONE-WHEN — every active `- [ ]` top-level entry carries a
//       `Done when:` (or `Done when (…):`) sub-bullet. See the legacy policy
//       below for why some sections are exempt.
//   (2) BRANCH-MARKER — every `🚧` in-flight entry names a `branch:`
//       (`(branch: X)` or the legacy `<!-- branch: X -->` HTML form), i.e.
//       an in-flight marker must say which branch it is in flight on.
//   (3) GATED-REF — every `gated on the <name> entry` cross-reference
//       resolves: `<name>` must appear in some OTHER entry title (**bold**)
//       or heading in the file. Catches a dangling gate after a rename/delete.
//   (4) NON-CHECKBOX-BULLET — a top-level `- ` bullet that is NOT a
//       `- [ ]`/`- [x]` checkbox may appear only under sections allowed to
//       hold history/decisions (§ Deferred decisions, Cross-cutting
//       invariants, superseded/implemented notes) — elsewhere a bare bullet
//       is almost always a checkbox someone forgot to make actionable.
//
// LEGACY POLICY (rule 1): ~24 pre-convention entries predate `Done when:`, so
// a flat rule-(1) gate would red-flag valid history. This linter uses a
// HYBRID, chosen deliberately over rewriting every legacy entry:
//   • GRANDFATHER (heading-anchored, NOT line-number) the four parked /
//     backlog clusters that hold pre-convention idea entries and are
//     explicitly NOT `/next-todo` autonomous work — see
//     GRANDFATHERED_SECTION_KEYS. New top-level sections, and the active
//     queue (Bugs / Editor UX / Internal quality-tooling), stay enforced.
//   • BACKFILL — the three pre-convention entries in the active
//     "Internal quality / tooling" section were given genuine `Done when:`
//     bullets (a local-only TODO edit; the TODO file is untracked) so that
//     the whole active queue meets the convention rather than being exempt.
// Anchoring by heading (not line number) means inserting/removing lines above
// a section never silently shifts the exemption; renaming a heading lapses
// the exemption (re-flag rather than silently exempt — the safe direction).
//
// Usage:
//   node scripts/check-todo-hygiene.mjs [path-to-todo.md]
// Default path: .claude/docs/TODO.md. Exit 0 = clean, 1 = violations,
// 2 = file unreadable.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_TODO = ".claude/docs/TODO.md";

// Headings whose entries are exempt from rule (1). Matched as a normalized
// substring of the heading text (emoji / `— …` suffixes stripped), so the
// anchor survives cosmetic heading edits but a real rename lapses it.
export const GRANDFATHERED_SECTION_KEYS = [
  "editor ux customization",
  "aspirational",
  "publish prep",
  "release plan",
];

// Headings allowed to hold top-level non-checkbox bullets (rule 4).
export const HISTORY_SECTION_KEYS = [
  "deferred decisions",
  "cross cutting invariants",
  "superseded",
  "implemented notes",
];

// Lowercase, drop everything but ascii letters/digits, collapse runs to single
// spaces. `🧭 Editor UX / customization` → `editor ux customization`.
export function normalizeHeading(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function headingMatches(heading, keys) {
  const norm = normalizeHeading(heading);
  return keys.some((k) => norm.includes(k));
}

// Strip inline-code spans so backticked prose (e.g. the rule text
// `gated on X`, or `Done when:` mentioned in a headline) never triggers a
// rule. Fenced code blocks are handled separately by the fence tracker.
function stripInlineCode(line) {
  return line.replace(/`[^`]*`/g, "");
}

// Walk the file once, producing per-line metadata: the enclosing heading, an
// in-fenced-code flag (length-aware so a ```` block wrapping ``` examples is
// treated as one opaque span), and the top-level entries with their sub-blocks.
export function analyzeTodo(text) {
  // Split on LF or CRLF — a stray trailing \r defeats the $-anchored heading /
  // checkbox regexes below (JS `.` and `$` do not span \r without the `m`
  // flag), which would silently detect zero entries and pass a CRLF-authored
  // TODO vacuously. Normalizing here keeps every rule CRLF-safe.
  const lines = text.split(/\r?\n/);
  const meta = []; // { text, heading, inFence } per line, 1-based via idx+1
  const headings = []; // { line, text }
  let currentHeading = "(preamble)";
  let fence = null; // { char, len } when inside a fenced block

  for (const raw of lines) {
    const fenceOpen = raw.match(/^(\s*)(`{3,}|~{3,})/);
    let inFence = fence != null;
    if (fence == null && fenceOpen) {
      // Opening a fence — the opener line itself counts as fenced.
      fence = { char: fenceOpen[2][0], len: fenceOpen[2].length };
      inFence = true;
    } else if (fence != null && fenceOpen) {
      // A candidate closer only closes when same char AND length >= opener.
      const m = fenceOpen[2];
      if (m[0] === fence.char && m.length >= fence.len) {
        fence = null; // this line closes the fence but is still "in" it
      }
    }

    if (!inFence) {
      const h = raw.match(/^(#{2,6})\s+(.*)$/);
      if (h) {
        currentHeading = h[2].trim();
        headings.push({ line: meta.length + 1, text: currentHeading });
      }
    }
    meta.push({ text: raw, heading: currentHeading, inFence });
  }

  // Group top-level (column-0) checkbox entries with their following
  // sub-block (blank or indented lines, until the next column-0 non-indented
  // construct). Fenced lines never start an entry.
  const entries = [];
  for (let i = 0; i < meta.length; i++) {
    const { text: raw, heading, inFence } = meta[i];
    if (inFence) {
      continue;
    }
    const cb = raw.match(/^- \[([ xX])\]\s+(.*)$/);
    if (!cb) {
      continue;
    }
    const start = i;
    let j = i + 1;
    for (; j < meta.length; j++) {
      const l = meta[j].text;
      if (l.trim() === "") {
        continue; // blank — may be interior whitespace
      }
      if (/^\s/.test(l)) {
        continue; // indented — part of this entry
      }
      break; // column-0 non-blank line → next construct
    }
    const block = meta.slice(start, j).map((m) => m.text);
    // Prefer the **bold** headline; else the checkbox's captured remainder
    // (cb[2] — the text after `- [ ] `). Used only in violation messages.
    const title = (raw.match(/\*\*(.+?)\*\*/)?.[1] ?? cb[2].trim()).slice(0, 80);
    entries.push({
      line: start + 1,
      heading,
      checked: cb[1].toLowerCase() === "x",
      hasMarker: raw.includes("🚧"),
      hasBranch: /\(branch:\s*[^)]+\)/.test(raw) || /<!--\s*branch:\s*.+?-->/.test(raw),
      title,
      block,
    });
    i = j - 1;
  }

  return { lines, meta, headings, entries };
}

// A `Done when:` sub-bullet: an indented `- Done when:` or `- Done when (…):`.
function blockHasDoneWhen(block) {
  return block.slice(1).some((l) => /^\s+-\s+done when\b/i.test(l));
}

// RULE 1 — active `- [ ]` entries need a `Done when:` sub-bullet, unless the
// entry sits under a grandfathered heading.
export function lintDoneWhen(text, analyzed = analyzeTodo(text)) {
  const out = [];
  for (const e of analyzed.entries) {
    if (e.checked) {
      continue;
    }
    if (headingMatches(e.heading, GRANDFATHERED_SECTION_KEYS)) {
      continue;
    }
    if (!blockHasDoneWhen(e.block)) {
      out.push({
        rule: 1,
        line: e.line,
        message: `active entry has no "Done when:" sub-bullet: ${e.title}`,
      });
    }
  }
  return out;
}

// RULE 2 — every 🚧 in-flight entry names a branch.
export function lintBranchMarker(text, analyzed = analyzeTodo(text)) {
  const out = [];
  for (const e of analyzed.entries) {
    if (!e.hasMarker) {
      continue;
    }
    if (!e.hasBranch) {
      out.push({
        rule: 2,
        line: e.line,
        message: `🚧 in-flight entry names no branch (expect "(branch: …)"): ${e.title}`,
      });
    }
  }
  return out;
}

// RULE 3 — a `gated on the <name> entry` reference must resolve to some OTHER
// entry title or heading. Inline code and fenced blocks are ignored so the
// rule's own documentation text does not trigger it.
export function lintGatedRefs(text, analyzed = analyzeTodo(text)) {
  const out = [];
  // Candidate referents: every heading + every bold entry title, tagged with
  // the line they live on (so a reference never resolves against itself).
  const referents = [];
  for (const h of analyzed.headings) {
    referents.push({ line: h.line, norm: normalizeHeading(h.text) });
  }
  for (const e of analyzed.entries) {
    referents.push({ line: e.line, norm: normalizeHeading(e.title) });
  }

  const gatedRe = /gated on (?:the )?(.+?) entry\b/gi;
  for (let i = 0; i < analyzed.meta.length; i++) {
    const m = analyzed.meta[i];
    if (m.inFence) {
      continue;
    }
    const line = i + 1;
    const scan = stripInlineCode(m.text);
    for (const match of scan.matchAll(gatedRe)) {
      const name = normalizeHeading(match[1]);
      if (!name) {
        continue;
      }
      const resolved = referents.some((r) => r.line !== line && r.norm.includes(name));
      if (!resolved) {
        out.push({
          rule: 3,
          line,
          message: `"gated on … ${match[1].trim()} entry" does not resolve to any other entry/heading`,
        });
      }
    }
  }
  return out;
}

// RULE 4 — top-level non-checkbox bullets only under history/decision sections.
export function lintNonCheckboxBullets(text, analyzed = analyzeTodo(text)) {
  const out = [];
  for (let i = 0; i < analyzed.meta.length; i++) {
    const { text: raw, heading, inFence } = analyzed.meta[i];
    if (inFence) {
      continue;
    }
    // Column-0 `- ` bullet that is not a `- [ ]`/`- [x]` checkbox.
    if (!/^- (?!\[[ xX]\]\s)/.test(raw)) {
      continue;
    }
    if (headingMatches(heading, HISTORY_SECTION_KEYS)) {
      continue;
    }
    out.push({
      rule: 4,
      line: i + 1,
      message: `top-level non-checkbox bullet outside an allowed history/decisions section (under "${heading}")`,
    });
  }
  return out;
}

// Run all four rules, sorted by line.
export function lintTodoText(text) {
  const analyzed = analyzeTodo(text);
  return [
    ...lintDoneWhen(text, analyzed),
    ...lintBranchMarker(text, analyzed),
    ...lintGatedRefs(text, analyzed),
    ...lintNonCheckboxBullets(text, analyzed),
  ].sort((a, b) => a.line - b.line || a.rule - b.rule);
}

const RULE_LABEL = {
  1: "Done-when",
  2: "branch-marker",
  3: "gated-ref",
  4: "non-checkbox-bullet",
};

function main() {
  const todoPath = process.argv[2] ?? DEFAULT_TODO;
  let text;
  try {
    text = readFileSync(todoPath, "utf8");
  } catch (err) {
    console.error(`check-todo-hygiene: cannot read ${todoPath}: ${err.message}`);
    process.exit(2);
  }

  const violations = lintTodoText(text);
  if (violations.length === 0) {
    console.log(`check-todo-hygiene: ${todoPath} — OK (no convention violations)`);
    process.exit(0);
  }

  console.error(
    `check-todo-hygiene: ${violations.length} convention violation(s) in ${todoPath}\n`
  );
  for (const v of violations) {
    console.error(`  ✗ ${todoPath}:${v.line}  [${RULE_LABEL[v.rule]}] ${v.message}`);
  }
  console.error(
    "\nConventions live in the TODO.md header (Done when: / 🚧 branch: / gated on).\n" +
      "Legacy policy + the four rules are documented in scripts/check-todo-hygiene.mjs."
  );
  process.exit(1);
}

// Only run main when invoked directly (not when imported by the test suite).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { DEFAULT_TODO };
