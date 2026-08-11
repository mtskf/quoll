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
// The two consumers now read a RESOLVED verdict rather than this raw one:
// cm/link-resolve.ts turns a LinkTarget into a ResolvedLinkTarget (the
// `fragment` arm becomes `scroll` or `no-action`) and owns
// `isActionableLinkTarget`, which used to live here. This module stayed pure as
// a result: the fragment arm needs a DOCUMENT to be judged, and the answer to
// "does this act?" is not a property of the string. Keep it that way — no
// EditorState, no Tree, no callbacks in this file.
//
// TOTALITY IS A HARD CONTRACT — this module must never throw. It runs inside
// DecorationProvider.build(), and the orchestrator drives EVERY inline
// decoration provider from a SINGLE shared ViewPlugin. CodeMirror's
// PluginInstance.update catches a plugin throw and then deactivates that
// plugin PERMANENTLY, so a throw here does not just drop the link marker: it
// takes down EVERY provider in `decorations/index.ts`'s syntaxRevealProviders
// — headings, blockquotes, emphasis, links, task checkboxes, bullet markers,
// fenced code, thematic breaks, setext, code refs — until the user reloads the
// window, with only a console.error to show for it. Block widgets (tables,
// images, frontmatter) are StateFields and survive, so the blast radius is
// "the whole inline reveal layer" rather than literally every decoration —
// which is a distinction about scope, not about severity.
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
// `slug` on the `fragment` arm is the third such field and the strictest: it is
// neither posted nor logged. It is href bytes (post-allowlist and slugified,
// but `#project-atlas-launch-date` is still private text), and its only legal
// use is a lookup in cm/link-resolve.ts.
//
// DRIFT WARNING (inherited from link-handlers.ts): the OPENABLE_SCHEMES set +
// schemeOf helper below are mirrored in
// src/extension/links/handle-open-external.ts (host arm) and MUST behave
// identically. Both sides' hostile-URL matrices
// (test/extension/links/handle-open-external.test.ts and
// test/webview/cm-link-handlers.test.ts + cm-link-target.test.ts +
// test/webview/decorations/cm-link-integration.test.ts) red on drift. A shared
// host+webview module remains rejected as scope creep — the duplication is ~10
// LOC on each side of a process boundary, and collapsing it would add a third
// module to the C9b deletion footprint. This extraction is therefore
// single-source-of-truth WITHIN the webview, not across the boundary.

import { isAllowedUrl } from "../../markdown/url-allowlist.js";
import { MAX_HREF_LENGTH } from "../../shared/protocol.js";
import { slugifyHeadingText } from "./headings.js";

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
const LOGGABLE_SCHEMES = [
  "http",
  "https",
  "mailto",
  "javascript",
  "vbscript",
  "data",
  "blob",
  "file",
  "about",
] as const;

/** Every string `schemeToken` can ever hold. A literal union, not `string`, so
 *  the NO-URL POLICY is checked by tsc rather than asserted in prose: an
 *  attempt to put an href-derived value on the `blocked` arm reds with TS2322
 *  at the assignment, instead of relying on a reviewer noticing. */
type LoggableSchemeToken = (typeof LOGGABLE_SCHEMES)[number] | "(none)" | "(unrecognised)";

/** Lowercase-first scheme extract. Same regex shape as isAllowedUrl and the
 *  host arm — see the DRIFT WARNING above. Module-private on purpose: exporting
 *  it would hand consumers the raw pre-colon run of href bytes, the one value
 *  the NO-URL POLICY exists to keep out of logs. */
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
function schemeTokenForLog(scheme: string | null): LoggableSchemeToken {
  if (scheme === null) {
    return "(none)";
  }
  // `.find` rather than a Set `.has`: `has` narrows nothing, so the result
  // would have to be returned as the untyped input string — which is exactly
  // the href-derived value this function exists to keep out of logs. `find`
  // returns the matched LITERAL from the table, so what leaves here provably
  // came from the table and not from the input. `schemeOf` lowercases before
  // matching, so membership is case-exact.
  return LOGGABLE_SCHEMES.find((s) => s === scheme) ?? "(unrecognised)";
}

/** What a decoded destination resolves to — the STRING verdict, which is only
 *  the FIRST of two stages. `external` and `workspace` are actionable as they
 *  stand: a click acts on them and they earn a pointer cursor. `fragment` is
 *  undecided here — it acts only if THIS document has a heading with that slug,
 *  and cm/link-resolve.ts is the stage that answers it (it turns the arm into
 *  `scroll` / `no-action` / `unresolved-fragment` and owns the
 *  `isActionableLinkTarget` predicate both consumers read). The remaining arms
 *  are the dead-click classes, split by cause so link-handlers can keep one
 *  distinct warn per gate (PR #332's triage trail). `no-action` is the silent
 *  one: ordinary Markdown Quoll does not route. */
export type LinkTarget =
  | { readonly kind: "external"; readonly href: string }
  | { readonly kind: "workspace"; readonly href: string }
  /** A same-document `#slug` destination, carrying only the slugified fragment.
   *  Not actionable on its own: whether a click does anything depends on the
   *  DOCUMENT (does a heading produce this slug?), which this module
   *  deliberately cannot see. cm/link-resolve.ts answers that for both
   *  consumers. Nothing is posted and nothing is logged. */
  | { readonly kind: "fragment"; readonly slug: string }
  | { readonly kind: "oversize"; readonly length: number }
  | { readonly kind: "blocked"; readonly schemeToken: LoggableSchemeToken }
  | { readonly kind: "unopenable-scheme"; readonly scheme: string }
  | { readonly kind: "no-action" };

/** True when `decoded` is a schemeless, NON-ABSOLUTE destination whose path
 *  (after stripping a trailing #fragment AND percent-decoding) ends in `.md`
 *  (case-insensitive) — i.e. a relative in-workspace Markdown link eligible for
 *  the `open-link` page-to-page path. Caller has already confirmed
 *  `schemeOf(decoded) === null`.
 *
 *  MUST mirror `handleOpenLink`'s structural gate, and specifically must apply
 *  it to the PERCENT-DECODED path, because that is the form the host judges.
 *  Checking only the raw form makes `[x](%2Fetc.md)` look like an ordinary
 *  relative `.md` link here while the host decodes it to `/etc.md` and drops it
 *  as absolute — and since this side already posted, `preventDefault` has fired,
 *  so that click loses its caret move too. That is the exact dead click this
 *  module exists to stop the cursor from promising, so the two sides have to
 *  agree about which STRING they are judging, not merely about the rules
 *  (Codex Conf 99). `%5C…` and `%2F%2F…` are the same mismatch.
 *
 *  The absolute-path reject stops an absolute link from being CONSUMED here
 *  (which would swallow the caret move) even though the host would drop it. The
 *  host re-derives + re-validates all of this — this is the webview-side half of
 *  the defense-in-depth gate, not a substitute for it. */
function relativeMarkdownTarget(decoded: string): boolean {
  // Split the fragment on the ENCODED form: a literal `#` in a filename is
  // `%23`, so URL-structural splitting must precede percent-decoding. Mirrors
  // handleOpenLink.
  const hashIdx = decoded.indexOf("#");
  const encodedPath = hashIdx >= 0 ? decoded.slice(0, hashIdx) : decoded;
  if (encodedPath.length === 0) {
    return false;
  }
  // Percent-decode ONCE so `my%20notes.md` is judged as the real space-named
  // file. decodeURIComponent throws on a malformed escape (`50%off.md`) — fall
  // back to the raw form exactly as the host does, so such a link keeps
  // resolving to its literal-named file. The try/catch is the host's documented
  // fallback, NOT a swallowed bug: it is what keeps this module total (see the
  // header's totality contract), since decodeURIComponent is the one throwing
  // primitive in this file.
  let pathPart: string;
  try {
    pathPart = decodeURIComponent(encodedPath);
  } catch {
    pathPart = encodedPath;
  }
  // Re-apply the allowlist to the DECODED form: catches C0/DEL bytes and
  // protocol-relative `//host` that were hidden behind percent-escapes.
  if (!isAllowedUrl(pathPart)) {
    return false;
  }
  // isAllowedUrl accepts mailto:/http: — but open-link targets are schemeless.
  if (schemeOf(pathPart) !== null) {
    return false;
  }
  // Reject absolute `/…` and ANY backslash (markdown paths use `/`; a `\` is a
  // separator under real Uri.joinPath but not the test stub — reject it so the
  // host containment check is separator-agnostic). Mirrors handleOpenLink.
  if (pathPart.startsWith("/") || pathPart.includes("\\")) {
    return false;
  }
  return /\.md$/i.test(pathPart);
}

/** Normalise a raw `#…` fragment (the bytes AFTER the `#`) into the slug form
 *  the heading index is keyed by. Percent-decode first — `#My%20Section` and
 *  `#My Section` name the same heading — then run the SAME
 *  `slugifyHeadingText` the index uses.
 *
 *  Sharing that one function is what makes a match symmetric: the two sides
 *  start from different domains (a decoded identifier here, raw Markdown source
 *  there), so agreeing on the RULES is not enough — they have to agree on the
 *  FUNCTION. It is idempotent, so slugging an already-slugged fragment is a
 *  no-op, and it makes matching tolerant of case and punctuation
 *  (`#Getting-Started!` → `getting-started`).
 *
 *  decodeURIComponent is the one throwing primitive in this file's reach and
 *  this module must never throw (see the header's totality contract), so a
 *  malformed escape falls back to the raw form — the same fallback
 *  relativeMarkdownTarget and the host use, so a `50%off` heading stays
 *  reachable rather than becoming a dead link. */
function fragmentSlug(rawFragment: string): string {
  let decodedFragment: string;
  try {
    decodedFragment = decodeURIComponent(rawFragment);
  } catch {
    decodedFragment = rawFragment;
  }
  return slugifyHeadingText(decodedFragment);
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
  // Schemeless. A leading `#` is a same-document fragment — resolved in the
  // webview against the document's own headings, so it needs no host round
  // trip. Ordered BEFORE relativeMarkdownTarget for readability only: that
  // helper already rejects a leading `#` (its path part is empty), so the two
  // arms cannot both match.
  if (decoded.startsWith("#")) {
    const slug = fragmentSlug(decoded.slice(1));
    // An empty or unsluggable fragment (`#`, `#!!!`) names no heading. Fall
    // through to no-action so the click stays a caret move.
    return slug === "" ? { kind: "no-action" } : { kind: "fragment", slug };
  }
  // Everything else schemeless: a relative `.md` link opens IN-EDITOR via the
  // host (phase-1 page-to-page); absolute paths and non-.md relatives are
  // ordinary Markdown Quoll does not route.
  if (relativeMarkdownTarget(decoded)) {
    return { kind: "workspace", href: decoded };
  }
  return { kind: "no-action" };
}
