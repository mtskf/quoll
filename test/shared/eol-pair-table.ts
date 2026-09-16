// The EOL-insensitivity contract as ONE table, shared by the two tests that pin
// it on opposite sides of the wire: test/shared/text-equality.test.ts (the pure
// helper) and test/extension/session/host-session-core.test.ts (the host's
// `contentMatches`, observed through the applyEditSettled drain). The webview's
// side is pinned behaviourally by cm-edit-sync.test.ts's "does NOT fire … on an
// EOL-only difference".
//
// WHY a shared table rather than a copy per side: the two predicates used to be
// byte-identical hand copies with nothing pinning them together, and one-sided
// drift is user-visible in both directions (widen the host's and the webview
// announces a discard on every epoch advance; widen the webview's and a real loss
// goes unannounced). A row added here is a row both sides must satisfy — a row
// cannot be added to one side only.
//
// NOT a test file: vitest collects `test/**/*.test.ts`, and importing a test file
// would re-register its suites inside the importing file.

/** One (a, b) pair and the verdict `sameTextIgnoringEol` owes it. `expected` is
 *  written out by hand on purpose — a table that computed its own answers from
 *  the function under test would pin nothing. */
export interface EolPair {
  readonly a: string;
  readonly b: string;
  readonly expected: boolean;
  /** Printable name — the raw strings carry control characters. */
  readonly label: string;
}

export const EOL_PAIRS: readonly EolPair[] = [
  { label: "CRLF vs LF", a: "a\r\nb", b: "a\nb", expected: true },
  // The regex has three alternatives; without this row only two are pinned. It
  // pins the HELPER, not the editor — cm/seed.ts does not accept a lone CR as a
  // document input.
  { label: "lone CR vs LF", a: "a\rb", b: "a\nb", expected: true },
  // Whitespace other than line endings is a REAL difference.
  { label: "trailing space", a: "a\nb", b: "a\nb ", expected: false },
  { label: "different text", a: "a", b: "b", expected: false },
  { label: "byte-identical", a: "a", b: "a", expected: true },
];
