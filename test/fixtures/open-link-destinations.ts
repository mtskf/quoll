// THE `open-link` STRUCTURAL CONTRACT, WRITTEN DOWN ONCE.
//
// Two modules on opposite sides of the process boundary answer the same
// question — "is this destination a relative in-workspace Markdown link the
// host will open?" — from two independent copies of the same cascade:
//
//   webview  src/webview/cm/link-target.ts   relativeMarkdownTarget()
//   host     src/extension/links/handle-open-link.ts   handleOpenLink()
//
// Both run: split the #fragment on the ENCODED form → percent-decode ONCE
// (raw-form fallback on a malformed escape) → isAllowedUrl on the DECODED form
// → reject a scheme → reject absolute `/…` or ANY backslash → require `.md`.
//
// The duplication is deliberate (defense in depth; the webview owns no path and
// the host trusts nothing it is sent), and a shared SOURCE module was rejected
// as scope creep — see the DRIFT WARNING in link-target.ts. What was NOT
// acceptable was the duplication being pinned by two suites with no destination
// string in common, so that a change on one side left the other green. That is
// not hypothetical: the webview copy once applied its checks to the
// NOT-percent-decoded string, so `%2Fetc.md`, `%5Cfoo.md` and `%2F%2Fhost.md`
// earned the pointer cursor, posted, and were `preventDefault`ed — then the
// host decoded them and dropped them. A *consumed* dead click: strictly worse
// than a plain one, because the caret move is eaten too (fixed in PR #340).
//
// A comment saying "MUST mirror handleOpenLink" is not a mechanism. This module
// is the mechanism: ONE matrix, consumed by BOTH suites, so flipping any single
// `hostRoutes` value reds a test on each side of the boundary.
//
//   test/webview/cm-link-target.test.ts        (webview classifier)
//   test/extension/links/handle-open-link.test.ts   (host handler)
//
// ── What the matrix does NOT cover ────────────────────────────────────────
// Only the STRUCTURAL cascade, i.e. the part both sides can decide from the
// destination string alone. Two neighbouring rules are deliberately excluded
// because including them would make the matrix lie:
//
//   - CONTAINMENT (does the resolved target stay in scope?) is host-only — the
//     webview owns no path and provably cannot evaluate it. That asymmetry is
//     real and load-bearing, so it gets its own export below rather than being
//     smuggled into the matrix as a `hostRoutes: false` row the webview would
//     have to disagree with.
//   - The MAX_HREF_LENGTH cap lives in the protocol validator (src/shared/
//     protocol.ts), UPSTREAM of handleOpenLink. An oversize destination never
//     reaches the host handler, which would happily route a 9 KiB relative
//     `.md` path — so `hostRoutes` has no honest value for it. The webview's
//     `oversize` arm is pinned in its own suite instead.

/** The document layout every `hostRoutes` verdict below is stated against. The
 *  host suite builds its deps from these two values rather than repeating the
 *  paths, so a row's verdict can never be read against a different layout than
 *  the one that produced it. */
export const OPEN_LINK_DOC_LAYOUT = {
  /** The open document — relative destinations resolve against its directory. */
  documentPath: "/ws/notes/doc.md",
  /** The single workspace folder root containing that document. */
  workspaceRoot: "/ws",
} as const;

export type OpenLinkCase = {
  /** The destination string, exactly as it appears in the Markdown source
   *  (post `decodeMarkdownDestination`, i.e. what the webview classifies and
   *  what the webview would post as the `open-link` href). */
  readonly destination: string;
  /** True when `handleOpenLink` opens this destination under
   *  OPEN_LINK_DOC_LAYOUT — equivalently, when the webview classifier must
   *  return `kind: "workspace"`. The biconditional IS the contract: a `false`
   *  row asserts the webview does NOT promise a pointer cursor and does NOT
   *  consume the click, whatever its non-routing reason (`external` for an
   *  `https:` link, `blocked`, `no-action`) happens to be. */
  readonly hostRoutes: boolean;
  /** Why this row exists — becomes the per-case test name on both sides, so a
   *  red row in CI names the rule that broke rather than just a string. */
  readonly why: string;
};

/** The shared matrix. Every row is decided by the structural cascade alone, so
 *  BOTH sides must agree on it. */
export const OPEN_LINK_STRUCTURAL_MATRIX: readonly OpenLinkCase[] = [
  // ── Routes: ordinary relative Markdown links ────────────────────────────
  { destination: "other.md", hostRoutes: true, why: "bare same-directory .md" },
  { destination: "./sub/other.md", hostRoutes: true, why: "dot-relative subdirectory .md" },
  {
    destination: "../sibling/other.md",
    hostRoutes: true,
    why: "parent-relative .md that stays in the workspace",
  },
  {
    destination: "./other.md#section",
    hostRoutes: true,
    why: "#fragment is split off before the structural gates",
  },
  { destination: "./other.MD", hostRoutes: true, why: ".md suffix match is case-insensitive" },
  // The decode exists to make the ordinary escaped form WORK, not merely to
  // reject things — these rows keep the percent-decode from being "fixed" into
  // a blanket reject.
  {
    destination: "my%20notes.md",
    hostRoutes: true,
    why: "percent-encoded space decodes to the real space-named file",
  },
  {
    destination: "./sub%20dir/my%20notes.md",
    hostRoutes: true,
    why: "percent-encoded space in a directory segment decodes too",
  },
  {
    destination: "50%off.md",
    hostRoutes: true,
    why: "malformed escape falls back to the raw form and still routes",
  },
  {
    destination: "./sub%20dir/50%off.md",
    hostRoutes: true,
    why: "decodeURIComponent is all-or-nothing — one bad escape means whole-string raw fallback",
  },

  // ── Does not route: not a Markdown target ───────────────────────────────
  { destination: "./other.txt", hostRoutes: false, why: "non-.md extension" },
  {
    destination: "./other.md.txt",
    hostRoutes: false,
    why: ".md must be the SUFFIX, not a substring",
  },
  { destination: "#section", hostRoutes: false, why: "fragment-only leaves an empty path" },

  // ── Does not route: structurally rejected in the raw form ───────────────
  { destination: "/etc/passwd.md", hostRoutes: false, why: "absolute path" },
  { destination: "..\\..\\escape.md", hostRoutes: false, why: "backslash separator" },
  {
    destination: "http://evil.example/x.md",
    hostRoutes: false,
    why: "http: scheme is not an open-link target",
  },
  {
    destination: "mailto:a@b.c",
    hostRoutes: false,
    why: "mailto: is allowlisted but not schemeless",
  },
  { destination: "//evil.example/x.md", hostRoutes: false, why: "protocol-relative" },
  { destination: "javascript:alert(1)", hostRoutes: false, why: "non-allowlisted scheme" },
  { destination: "./oth\u0001er.md", hostRoutes: false, why: "literal C0 control byte" },

  // ── Does not route: rejected ONLY once percent-decoded ──────────────────
  // The regression class PR #340 fixed. Each of these passes every gate in its
  // RAW form and fails one in its decoded form, so a side that judges the wrong
  // string classifies them as ordinary relative `.md` links. If the two sides
  // ever disagree again, it will be here.
  { destination: "%2Fetc.md", hostRoutes: false, why: "decodes to an absolute path" },
  { destination: "%5Cfoo.md", hostRoutes: false, why: "decodes to a backslash path" },
  { destination: "%2F%2Fhost.md", hostRoutes: false, why: "decodes to protocol-relative" },
  {
    destination: "http%3A%2F%2Fexample.com%2Fx.md",
    hostRoutes: false,
    why: "decodes to a scheme-bearing URL",
  },
  { destination: "./oth%01er.md", hostRoutes: false, why: "decodes to a C0 control byte" },
];

/** Destinations where the two sides DISAGREE — by design, not by drift.
 *
 *  Each passes the whole structural cascade, so the webview classifies it as
 *  `workspace`, promises the pointer cursor, posts, and `preventDefault`s. The
 *  host then resolves it and finds it OUTSIDE both the workspace folder and the
 *  document's own directory subtree, and drops it (log-only).
 *
 *  This is the intended split of responsibility: containment is asserted on the
 *  RESOLVED target, and only the host owns `document.uri`. Pinning the
 *  asymmetry here — rather than leaving it undescribed — keeps someone from
 *  "fixing the inconsistency" by adding these to the matrix above, which would
 *  demand the webview evaluate a boundary it cannot see. */
export const OPEN_LINK_CONTAINMENT_ONLY_REJECTIONS: readonly OpenLinkCase[] = [
  {
    destination: "../../etc/passwd.md",
    hostRoutes: false,
    why: "escapes the workspace via parent segments",
  },
  {
    destination: "..%2f..%2fsecret.md",
    hostRoutes: false,
    why: "escapes the workspace only after the percent-decode",
  },
];
