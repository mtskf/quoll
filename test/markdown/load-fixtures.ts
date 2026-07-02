import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Fixture {
  name: string;
  /** Header-stripped body — what Slice 4 round-trips against. */
  source: string;
  /** Untouched file contents — used by harness invariants (header presence, size cap). */
  raw: string;
  /** Byte length of the on-disk file (utf-8). */
  byteLength: number;
}

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
/** Slice 2 acceptance: every fixture file must stay under 16 KiB. */
export const MAX_FIXTURE_BYTES = 16 * 1024;
/** Slice 2 acceptance: every fixture must start with this one-line header. */
export const CASE_HEADER_PATTERN = /^<!--\s*case:[^\n]*-->\r?\n/;

// Strip a single leading `<!-- case: ... -->` header line so the header serves
// purely as reviewer metadata. Without this, mdast would surface it as an
// `html` node which the Slice 4 bridge will reject.
function stripCaseHeader(content: string): string {
  return content.replace(CASE_HEADER_PATTERN, "");
}

export function loadFixtures(): Fixture[] {
  const entries = readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith(".md"))
    .sort();

  return entries.map((file) => {
    const raw = readFileSync(join(FIXTURES_DIR, file), "utf8");
    return {
      name: file.replace(/\.md$/, ""),
      source: stripCaseHeader(raw),
      raw,
      byteLength: Buffer.byteLength(raw, "utf8"),
    };
  });
}
