// Non-vacuity pins for scripts/check-doc-sync.mjs.
//
// The linter enforces doc ⊆ code: every message name enumerated in
// CLAUDE.md's "Message protocol" bullet must still exist as a `type: "…"`
// message in src/shared/protocol.ts. These tests feed the PURE extraction /
// diff functions in-memory fixtures and assert both a clean baseline and a
// planted-drift case are caught — plus that doc-side extraction excludes
// non-message backtick tokens (paths, camelCase symbols).
//
// Why in-memory (never the real .claude/CLAUDE.md or protocol.ts): CLAUDE.md
// lives under `.claude/`, which is git-ignored and absent from CI checkouts,
// so reading it here would fail in CI. "Passes on current tree" is pinned
// separately by the local `pnpm check:doc-sync` run, not by this suite.
//
// @ts-nocheck — importing a plain .mjs with no bundled types; vitest runs
// this transpile-only and tsc does not include test/build/ in `pnpm compile`.
import { describe, expect, it } from "vitest";

import {
  extractCodeMessageTypes,
  extractDocMessageNames,
  findDrift,
} from "../../scripts/check-doc-sync.mjs";

// A minimal protocol.ts shaped like the real one: message types declare their
// discriminant via a `type: "…"` field; a builder repeats a literal (dedup);
// LintDiagnosticWire is a `type`-less sub-object that must be excluded.
const PROTOCOL = `export type DocumentMessage = Envelope & { type: "document"; content: string };
export type EditRejectedMessage = Envelope & { type: "edit-rejected"; error: unknown };
export type OpenExternalMessage = Envelope & { type: "open-external"; href: string };
export type OpenLinkMessage = Envelope & { type: "open-link"; href: string };
export type ImageWriteMessage = Envelope & { type: "image-write"; data: string };
export function buildSwitchToTextMessage() {
  return { protocol: 1, type: "switch-to-text" };
}
export type SwitchToTextMessage = Envelope & { type: "switch-to-text" };
export type LintDiagnosticWire = { startLine: number; severity: "warning" | "info" };
`;

// The guardrail bullet, verbatim shape: enumerates message names in backticks
// alongside a path and a camelCase symbol that must NOT be read as messages.
const CLAUDE_MD = `## Architecture invariants

- **Message protocol**: one versioned envelope in \`src/shared/protocol.ts\`. Non-negotiables: \`edit-rejected\` is sent instead of a reseed; \`open-external\` / \`open-link\` / \`image-write\` are re-validated host-side, with handoff deferred behind the \`editSettledBarrier\`. Mechanics: §6.
- **Security gates**: unrelated bullet.
`;

describe("check-doc-sync — code-side extraction", () => {
  it('pulls every `type: "…"` discriminant and dedupes builder repeats', () => {
    const types = extractCodeMessageTypes(PROTOCOL);
    expect([...types].sort()).toEqual([
      "document",
      "edit-rejected",
      "image-write",
      "open-external",
      "open-link",
      "switch-to-text",
    ]);
  });

  it("excludes a `type`-less sub-object (LintDiagnosticWire)", () => {
    const types = extractCodeMessageTypes(PROTOCOL);
    // startLine/severity fields carry no discriminant literal, so nothing leaks.
    expect(types.has("warning")).toBe(false);
    expect(types.has("info")).toBe(false);
  });
});

describe("check-doc-sync — doc-side extraction", () => {
  it("keeps only hyphenated message names, dropping path / camelCase tokens", () => {
    expect(extractDocMessageNames(CLAUDE_MD)).toEqual([
      "edit-rejected",
      "open-external",
      "open-link",
      "image-write",
    ]);
  });

  it("returns [] when the Message protocol bullet is absent", () => {
    expect(extractDocMessageNames("## Nothing here\n\n- **Other**: text.\n")).toEqual([]);
  });
});

describe("check-doc-sync — drift contract (doc ⊆ code)", () => {
  it("clean baseline: every enumerated name exists in code → no orphans", () => {
    const { orphans, docNames, bulletFound } = findDrift(PROTOCOL, CLAUDE_MD);
    expect(bulletFound).toBe(true);
    expect(docNames).toEqual(["edit-rejected", "open-external", "open-link", "image-write"]);
    expect(orphans).toEqual([]);
  });

  it("planted drift: a renamed code type orphans the doc reference", () => {
    // Simulate `edit-rejected` renamed away in protocol.ts; the bullet still
    // mentions it → it must be reported as stale.
    const renamed = PROTOCOL.replace('type: "edit-rejected"', 'type: "edit-rejected-X"');
    const { orphans } = findDrift(renamed, CLAUDE_MD);
    expect(orphans).toEqual(["edit-rejected"]);
  });

  it("an unrelated extra code message does NOT orphan anything (bullet is not exhaustive)", () => {
    const extra = `${PROTOCOL}export type FakeMsg = { type: "fake-msg" };\n`;
    const { orphans } = findDrift(extra, CLAUDE_MD);
    expect(orphans).toEqual([]);
  });
});
