// What an inline Markdown link destination IS, decided once.
//
// Two consumers used to answer this question separately and disagree:
// cm/link-handlers.ts ran the full gate cascade to decide whether to post a
// host message, while cm/decorations/link-reveal.ts applied the
// `quoll-link-clickable` (cursor: pointer) mark to EVERY inline Link with a
// URL child. A fragment or a `./photo.png` therefore rendered exactly like a
// working link and then did nothing on click. One classifier, two consumers,
// so the affordance cannot drift from the behaviour again.
//
// TOTALITY IS A HARD CONTRACT — this module must never throw. It runs inside
// DecorationProvider.build(); the orchestrator registers ONE ViewPlugin for
// every provider, and CodeMirror's PluginInstance.update catches a plugin
// throw and then deactivates the plugin PERMANENTLY. A throw here would strip
// every decoration in the editor — links, emphasis, tables, headings — until
// the user reloads the window, with only a console.error to show for it.
// test/webview/cm-link-target.test.ts pins this against a hostile matrix.
// Keep it to string/regex/Set work: no `new URL()`, no JSON.parse, no
// unguarded String.fromCodePoint. (url-decode.ts's `decodableCodePoint` guard
// exists for exactly this reason.)
//
// NO-URL POLICY BOUNDARY — this module is where it is enforced, not merely
// observed. No REJECTION arm may carry unvalidated href bytes: `schemeToken`
// is classified HERE against LOGGABLE_SCHEMES so a consumer cannot leak a
// private pseudo-scheme by logging a field that looked innocuous. That makes
// the rejection arms checkable by reading one file instead of auditing every
// call site.
//
// The ACTIONABLE arms are the exception, and the distinction is the whole
// policy: `href` on `external` / `workspace` is post-allowlist but is still a
// full destination — `https://internal.example/secret-project` and
// `notes/private-plan.md` both pass the allowlist and are both private. POST
// it, never LOG it. So the rule for a consumer is: every field of a rejection
// arm is safe to log; `href` is safe to send to the host and nothing else.
//
// DRIFT WARNING (inherited from link-handlers.ts): the OPENABLE_SCHEMES set +
// schemeOf helper below are mirrored in
// src/extension/links/handle-open-external.ts (host arm) and MUST behave
// identically. Both sides' hostile-URL matrices
// (test/extension/handle-open-external.test.ts and
// test/webview/cm-link-handlers.test.ts + cm-link-target.test.ts) red on
// drift. A shared host+webview module remains rejected as scope creep — the
// duplication is ~10 LOC on each side of a process boundary, and collapsing it
// would add a third module to the C9b deletion footprint. This extraction is
// therefore single-source-of-truth WITHIN the webview, not across the boundary.

import { isAllowedUrl } from "../../markdown/url-allowlist.js";
import { MAX_HREF_LENGTH } from "../../shared/protocol.js";

const OPENABLE_SCHEMES = new Set(["http", "https", "mailto"]);

/** The schemes `schemeTokenForLog` will name on the PRE-validation path — the
 *  fixed set of in-file literals the NO-URL POLICY requires the token to be
 *  PICKED from, so an unvalidated href can only SELECT a member, never
 *  contribute bytes to one. Two groups, both earning their triage keep:
 *    - http / https / mailto — allowlisted schemes. Reaching the
 *      allowlist-reject path with one of these says the reject had a NON-scheme
 *      cause (a C0/DEL byte in the destination is the usual one), which is the
 *      single most useful thing that warn can tell a reporter.
 *    - javascript / vbscript / data / blob / file / about — the scheme families
 *      the render gate and the write validator exist to stop. Naming them turns
 *      "this link does nothing" into "this link was blocked, and here is why". */
const LOGGABLE_SCHEMES = new Set([
  "http",
  "https",
  "mailto",
  "javascript",
  "vbscript",
  "data",
  "blob",
  "file",
  "about",
]);

/** Lowercase-first scheme extract. Same regex shape as isAllowedUrl and the
 *  host arm — see the DRIFT WARNING above. Module-private on purpose: the only
 *  callers are below, and every CONSUMER wants the classified token, not a raw
 *  pre-colon run of href bytes. Exporting it would hand out the one value the
 *  NO-URL POLICY exists to keep out of logs. */
function schemeOf(url: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*):/.exec(url.toLowerCase());
  return match ? match[1] : null;
}

/** Render a scheme as a loggable token under the NO-URL POLICY. Mandatory on
 *  the PRE-validation path: `schemeOf`'s anchored regex bounds the token's
 *  ALPHABET but NOT its LENGTH, and — the reason a length cap was not enough —
 *  a SHORT pre-colon run is still href bytes: a destination such as
 *  `MyVault-Passw0rd.notes:entry` would echo a private fragment verbatim under
 *  any cap. So this classifies instead of truncating: a known scheme is named,
 *  anything else collapses to "(unrecognised)", and nothing varies with length
 *  (there is no threshold to widen). "URL not in allowlist" already carries the
 *  triage weight; the token only sharpens it. `null` renders as "(none)" so a
 *  protocol-relative / control-character reject stays distinguishable from a
 *  blocked scheme. */
function schemeTokenForLog(scheme: string | null): string {
  if (scheme === null) {
    return "(none)";
  }
  // `schemeOf` lowercases before matching, so membership is case-exact here.
  return LOGGABLE_SCHEMES.has(scheme) ? scheme : "(unrecognised)";
}

/** What a decoded destination resolves to. `external` and `workspace` are the
 *  two ACTIONABLE arms — exactly the arms a click acts on, and exactly the arms
 *  that earn a pointer cursor. The rest are the dead-click classes, split by
 *  cause so link-handlers can keep one distinct warn per gate (PR #332's triage
 *  trail). `no-action` is the silent one: ordinary Markdown Quoll does not route. */
export type LinkTarget =
  | { readonly kind: "external"; readonly href: string }
  | { readonly kind: "workspace"; readonly href: string }
  | { readonly kind: "oversize"; readonly length: number }
  | { readonly kind: "blocked"; readonly schemeToken: string }
  | { readonly kind: "unopenable-scheme"; readonly scheme: string }
  | { readonly kind: "no-action" };

/** True when `decoded` is a schemeless, NON-ABSOLUTE destination whose path
 *  (after stripping a trailing #fragment) ends in `.md` (case-insensitive) —
 *  i.e. a relative in-workspace Markdown link eligible for the `open-link`
 *  page-to-page path. Caller has already confirmed `schemeOf(decoded) === null`.
 *  The absolute-path reject stops an absolute link from being CONSUMED here
 *  (which would swallow the caret move) even though the host would drop it. The
 *  host (`handleOpenLink`) re-derives + re-validates all of this — this is the
 *  webview-side half of the defense-in-depth gate. */
function relativeMarkdownTarget(decoded: string): boolean {
  // Reject absolute `/…` and ANY backslash (markdown paths use `/`; a `\` is a
  // separator under real Uri.joinPath but not the test stub — reject it so the
  // host containment check is separator-agnostic). Mirrors handleOpenLink.
  if (decoded.startsWith("/") || decoded.includes("\\")) {
    return false;
  }
  const hashIdx = decoded.indexOf("#");
  const pathPart = hashIdx >= 0 ? decoded.slice(0, hashIdx) : decoded;
  return pathPart.length > 0 && /\.md$/i.test(pathPart);
}

/** Classify an already-decoded link destination. Gate ORDER is load-bearing and
 *  mirrors the cascade tryOpenLinkAt used before the extraction: length cap
 *  first (so an oversize href is rejected without running the allowlist over
 *  it), then isAllowedUrl, then scheme launchability, then the schemeless
 *  relative-`.md` arm. Reordering changes which reason a rejected href reports
 *  and would desync the two warn matrices. Total by contract — see the header. */
export function classifyLinkTarget(decoded: string): LinkTarget {
  // MAX_HREF_LENGTH mirrors the host's protocol validator: without it an
  // oversize href would post and the host would silently reject on shape,
  // leaving a no-op click AND a suppressed caret move.
  if (decoded.length > MAX_HREF_LENGTH) {
    return { kind: "oversize", length: decoded.length };
  }
  // Computed BEFORE the allowlist gate so the blocked arm can carry a triage
  // token. `decoded` is unvalidated here — only the length cap has run — which
  // is precisely why the token is classified before it leaves this function.
  const scheme = schemeOf(decoded);
  // Defense layer 1 (webview-side). Layer 2 (host-side handler) re-applies
  // isAllowedUrl on its end. Both must pass — defense in depth. Both sides
  // import isAllowedUrl from the same module so the gate cannot drift.
  if (!isAllowedUrl(decoded)) {
    return { kind: "blocked", schemeToken: schemeTokenForLog(scheme) };
  }
  if (scheme !== null) {
    if (!OPENABLE_SCHEMES.has(scheme)) {
      // Unreachable while ALLOWED_URL_SCHEMES ⊇ OPENABLE_SCHEMES — kept as
      // drift insurance so the caller's warn doubles as the runtime drift
      // signal. Same rationale as the host arm's mirror branch. Carried RAW
      // (not through schemeTokenForLog): post-allowlist the token is already an
      // element of ALLOWED_URL_SCHEMES — a set of literals in url-allowlist.ts
      // — so the POLICY's "PICKED from a fixed set" already holds, and naming
      // the drifted scheme is the only thing this arm exists to say.
      // Classifying would print "(unrecognised)" for exactly the case worth
      // reporting.
      return { kind: "unopenable-scheme", scheme };
    }
    return { kind: "external", href: decoded };
  }
  // Schemeless: a relative `.md` link opens IN-EDITOR via the host (phase-1
  // page-to-page). Everything else schemeless — fragments, absolute paths,
  // non-.md relatives — is ordinary Markdown Quoll does not route yet.
  if (relativeMarkdownTarget(decoded)) {
    return { kind: "workspace", href: decoded };
  }
  return { kind: "no-action" };
}

/** True for exactly the arms a click ACTS on. Consumers: the click handler
 *  (act, or fall through to a caret move) and the reveal decoration (pointer
 *  cursor, or leave the text cursor). Keeping the predicate here rather than at
 *  each call site is the whole point of the module — the cursor and the click
 *  read the same boolean.
 *
 *  Named for the INTENT ("a click does something") rather than the mechanism
 *  ("posts to the host"), even though every actionable arm posts today. A
 *  future in-document fragment scroll would act WITHOUT posting; under a
 *  post-shaped name it would have to either lie or force a rename of a shared
 *  predicate. Adding such an arm needs no new pointer-cursor WIRING — the
 *  cursor already reads this predicate — but note it is not free: a fragment
 *  is actionable only if its heading exists, and this module stays a pure
 *  string→verdict function with no document context, so the consumer resolves
 *  existence (see the fragment TODO). What the naming buys is that the arm
 *  joins without renaming a shared predicate, not that no consumer changes. */
export function isActionableLinkTarget(target: LinkTarget): boolean {
  return target.kind === "external" || target.kind === "workspace";
}
