#!/usr/bin/env node
// scripts/check-doc-sync.mjs
//
// Pin CLAUDE.md's "Message protocol" guardrail prose to the code, by machine
// instead of by judgement — the third of the repo's local-only doc/code
// linters (siblings: check-todo-hygiene.mjs, check-stale-todo-markers.mjs).
//
// Why this exists: `.claude/CLAUDE.md` → "## Architecture invariants" →
// "**Message protocol**" enumerates specific security-sensitive message names
// (`edit-rejected`, `open-external`, `open-link`, `image-write`) inline as a
// hand-maintained guardrail. When a message type is renamed or removed in
// src/shared/protocol.ts, nothing forces that prose to follow — a 2026-07-11
// audit found 5 of 7 such code-derived enumerations across CLAUDE.md had gone
// stale. This script fails when a message name the bullet still mentions no
// longer exists as a protocol message type, so the drift surfaces at
// `pnpm check:doc-sync` time rather than silently rotting.
//
// Why LOCAL-only (no CI equivalent): like both siblings, this reads a file
// under `.claude/`, which is git-ignored and therefore ABSENT from CI
// checkouts. A GitHub Action would run against a missing file. So it ships as
// a tracked script under scripts/ plus a `pnpm check:doc-sync` entry, run
// locally. See CLAUDE.md § "Merging PRs" for why `.claude/` is out of git.
//
// ─────────────────────────────────────────────────────────────────────────
// THE CONTRACT — doc ⊆ code (deliberate direction; see below)
//
// Every message name the CLAUDE.md bullet enumerates MUST still exist as a
// message type in protocol.ts. Fail (exit 1) listing any orphaned name.
//
// Why NOT the reverse (code ⊆ doc, "every protocol message must appear in the
// bullet"): the bullet intentionally lists only the security-sensitive /
// non-negotiable messages, not all ~18 — it explicitly says "the message-type
// list lives there, don't duplicate it elsewhere". A full-enumeration equality
// would be immediately red and would force copying the entire union into the
// doc, defeating the bullet's design. doc ⊆ code is the meaningful,
// low-maintenance guard: it catches exactly the failure the originating TODO
// describes — a code rename silently orphaning stale guardrail prose.
//
// Reconciling the TODO's "add a fake message type … fails" wording: under
// doc ⊆ code, adding an *unrelated* message to protocol.ts does NOT fail (the
// bullet is not an exhaustive mirror — by design). The divergence this guard
// detects is a RENAME/REMOVAL of an *enumerated* name. Non-vacuity is verified
// by renaming an enumerated message in protocol.ts (e.g. `edit-rejected` →
// `edit-rejected-X`) and watching this go red — the revert-check documented in
// the plan and the drift fixture in test/build/doc-sync.test.ts.
//
// ─────────────────────────────────────────────────────────────────────────
// EXTRACTION
//
// Code side (extractCodeMessageTypes): every message type declares its
// discriminant as a `type: "…"` field literal (`type: "document";`,
// `type: "edit-rejected";`), and the two `build*Message` helpers repeat the
// same literals — dedup collapses those. `LintDiagnosticWire` (a sub-object,
// no `type:` field) and `Envelope` are correctly excluded. Direction is NOT
// split: the bullet does not distinguish host/webview, so the combined
// universe of valid names is what the guard needs.
//
// Doc side (extractDocMessageNames): from the single `- **Message protocol**`
// bullet, take backticked tokens matching lowercase kebab-case with at least
// one hyphen. That captures the enumerated names while excluding the path
// `src/shared/protocol.ts` (has `/` `.`) and the camelCase symbol
// `editSettledBarrier`. ACCEPTED LIMITATION: single-word message names
// (`document`/`theme`/`edit`/`ready`) are NOT checked — they are generic
// lifecycle primitives (not the security guardrail this bullet pins) and
// collide with ordinary English prose words, so requiring a hyphen removes the
// main false-positive risk. Every message the bullet is designed to call out
// is multi-word, so the guardrail's actual purpose is fully covered.
//
// Non-vacuity backstops (a broken regex must fail loud, never pass green):
//   - code set < 5 names  → exit 2 (the type: regex almost certainly broke)
//   - 0 doc names found    → exit 2 (the bullet was reworded past recognition)
//
// Usage:
//   node scripts/check-doc-sync.mjs [protocol.ts] [CLAUDE.md]
// Exit 0 = in sync, 1 = drift, 2 = unreadable file / extraction broke.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const DEFAULT_PROTOCOL = "src/shared/protocol.ts";
export const DEFAULT_CLAUDE_MD = ".claude/CLAUDE.md";

// Minimum plausible size of the code-side message set. The real union is ~18;
// anything under this means the `type:` regex stopped matching (a reformat, a
// moved file) and the run must fail loud rather than pass vacuously.
const MIN_CODE_MESSAGE_TYPES = 5;

// A protocol message name on the wire: lowercase, digits, hyphens only.
const CODE_TYPE_RE = /\btype:\s*"([a-z][a-z0-9-]*)"/g;

// A backticked token counts as an enumerated MESSAGE NAME iff it is lowercase
// kebab-case with >= 1 hyphen (see the doc-side note above for why single-word
// tokens are deliberately out of scope).
const DOC_NAME_SHAPE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;

/** Every message-type discriminant string declared in protocol.ts, deduped. */
export function extractCodeMessageTypes(protocolText) {
  const out = new Set();
  for (const m of protocolText.matchAll(CODE_TYPE_RE)) {
    out.add(m[1]);
  }
  return out;
}

/** The hyphenated message names enumerated in the "Message protocol" bullet,
 *  in first-seen order. Returns [] if the bullet cannot be located (the caller
 *  treats that as an extraction failure, not "nothing to check"). */
export function extractDocMessageNames(claudeMdText) {
  const lines = claudeMdText.split(/\r?\n/);
  // The bullet is a single physical line beginning `- **Message protocol**`.
  const bullet = lines.find((l) => /^- \*\*Message protocol\*\*/.test(l));
  if (bullet === undefined) {
    return [];
  }
  const names = [];
  for (const m of bullet.matchAll(/`([^`]+)`/g)) {
    const token = m[1];
    if (DOC_NAME_SHAPE.test(token) && !names.includes(token)) {
      names.push(token);
    }
  }
  return names;
}

/** Compare the two sides. `orphans` = enumerated doc names absent from the
 *  code set. `bulletFound` is false when the bullet could not be located. */
export function findDrift(protocolText, claudeMdText) {
  const codeTypes = extractCodeMessageTypes(protocolText);
  const bulletFound = /^- \*\*Message protocol\*\*/m.test(claudeMdText);
  const docNames = extractDocMessageNames(claudeMdText);
  const orphans = docNames.filter((n) => !codeTypes.has(n));
  return { orphans, docNames, codeCount: codeTypes.size, bulletFound };
}

function main() {
  const protocolPath = process.argv[2] ?? DEFAULT_PROTOCOL;
  const claudeMdPath = process.argv[3] ?? DEFAULT_CLAUDE_MD;

  let protocolText;
  let claudeMdText;
  try {
    protocolText = readFileSync(protocolPath, "utf8");
  } catch (err) {
    console.error(`check-doc-sync: cannot read ${protocolPath}: ${err.message}`);
    process.exit(2);
  }
  try {
    claudeMdText = readFileSync(claudeMdPath, "utf8");
  } catch (err) {
    console.error(`check-doc-sync: cannot read ${claudeMdPath}: ${err.message}`);
    process.exit(2);
  }

  const { orphans, docNames, codeCount, bulletFound } = findDrift(protocolText, claudeMdText);

  // Non-vacuity backstops — a broken extraction fails loud, never green.
  if (codeCount < MIN_CODE_MESSAGE_TYPES) {
    console.error(
      `check-doc-sync: only ${codeCount} message type(s) extracted from ${protocolPath} ` +
        `(expected ≥ ${MIN_CODE_MESSAGE_TYPES}). The \`type: "…"\` extraction likely broke — ` +
        "refusing to pass vacuously."
    );
    process.exit(2);
  }
  if (!bulletFound) {
    console.error(
      `check-doc-sync: could not find the "- **Message protocol**" bullet in ${claudeMdPath}. ` +
        "The guardrail prose moved or was reworded — refusing to pass vacuously."
    );
    process.exit(2);
  }
  if (docNames.length === 0) {
    console.error(
      `check-doc-sync: the "Message protocol" bullet in ${claudeMdPath} enumerates no message ` +
        "names (expected e.g. `edit-rejected`). It was reworded past recognition — refusing to " +
        "pass vacuously."
    );
    process.exit(2);
  }

  if (orphans.length === 0) {
    console.log(
      `check-doc-sync: ${docNames.length} enumerated message name(s) in ${claudeMdPath} ` +
        `all present in ${protocolPath} — OK`
    );
    process.exit(0);
  }

  console.error(`check-doc-sync: ${orphans.length} stale message name(s) in ${claudeMdPath}\n`);
  for (const name of orphans) {
    console.error(`  ✗ \`${name}\` is enumerated in the "Message protocol" bullet but no`);
    console.error(`      \`type: "${name}"\` message exists in ${protocolPath}`);
  }
  console.error(
    "\nRemediation: a message type was renamed/removed in protocol.ts, orphaning the\n" +
      'CLAUDE.md guardrail prose. Update the "Message protocol" bullet to the current\n' +
      "name(s), then re-run this check."
  );
  process.exit(1);
}

// Only run main when invoked directly (not when imported by the test suite).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
