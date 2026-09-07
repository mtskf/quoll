// Session-independent VERIFIED write executor (Plan S6, findings #7/#8).
//
// One function — `executeDocumentWrite` — owns the whole host-initiated write
// pipeline over an injected VS Code adapter: snapshot → `minimalEditSpan` →
// build → apply → POST-APPLY VERIFY → immutable tagged outcome. Both host-side
// writers route through it: the reducer's flushed-edit path (effect-executor's
// `runApplyEdit` wrapper) and revert-rescue's restore. Deliberately NOT under
// `session/` — the surface lifecycle's independence from session internals is a
// design decision (revert-rescue-wiring.ts:19-27), and the rescue must run at
// dispose when the reducer is dormant.
//
// Claim scoped honestly (plan I5): this is bounded post-hoc DETECTION plus
// corrective convergence, NOT prevention. On the single-threaded ext host,
// snapshot→span→build→apply is one synchronous tick — a pre-apply re-read can
// never observe a change, so this layer takes NO pre-apply re-samples. The
// hazard lives INSIDE the applyEdit RPC and ext-host model lag (S5 verdict:
// desktop MISPLACES a stale-offset splice, LEARNING.md 2026-07-25), visible
// only AFTER the apply settles. This layer cannot un-land a bad splice nor
// restore bytes it clobbered; it detects the divergence and lets every caller
// converge on one authoritative state. TWO escapes from that detection, both
// reported honestly rather than hidden: a wrong splice whose final bytes
// COINCIDENTALLY equal the intended bytes (reported `applied` — indistinguishable
// by bytes), and a settle-time content read that THROWS, where no compare runs at
// all (reported `appliedUnverified` — landed, unverified, never `diverged`).
//
// The adapter is the ONLY VS Code touch, so this module stays `vscode`-free and
// unit-testable against a fake. Every read/build/apply is injected; the module
// never re-reads outside the adapter, and — the caller contract — the returned
// outcome CARRIES its verification-time snapshots so callers map from those
// fields and NEVER re-read the document (a wrapper re-read can observe a later
// edit and mis-attribute divergence).

import { perfNow, perfRecord } from "../../shared/perf.js";
import type { MinimalEditSpan } from "./minimal-edit.js";
import { minimalEditSpan } from "./minimal-edit.js";

/** The injected VS Code seam. `readText` = the raw live buffer (pre-apply OLD
 *  text, offsets map to it via `positionAt` inside `build`). `readCanonical` =
 *  the EOL-normalised document text (`canonicalDocumentText`). `canonicalize` =
 *  the string-level EOL normaliser to the document's EOL. `build` may throw
 *  (→ buildThrew); `apply` may throw synchronously (→ applyThrew), reject
 *  (→ applyRejected), or resolve false (→ applyRefused) / true (→ applied |
 *  diverged | appliedUnverified).
 *
 *  Throw assumptions, split by WHEN the seam runs:
 *   - `readText` / `canonicalize` are still assumed non-throwing. They run in the
 *     SYNCHRONOUS prefix, BEFORE anything can land, so a throw there correctly
 *     rejects a write that never happened — the caller's rejection arm is then
 *     telling the truth.
 *   - `readCanonical` / `readVersion` are NOT assumed non-throwing any more. They
 *     are the SETTLE-time verification reads, and by then an apply may already
 *     have LANDED; a throw there is a missing VERIFICATION, not a failed write.
 *     Each is individually guarded inside `settle()` (see there). */
export interface DocumentWriteAdapter {
  readText: () => string;
  readVersion: () => number;
  readCanonical: () => string;
  canonicalize: (text: string) => string;
  build: (span: MinimalEditSpan) => unknown;
  apply: (edit: unknown) => Thenable<boolean>;
}

/** Complete outcome tag set — one per today's five `ApplyEditOutcome` kinds,
 *  plus `diverged` (an `ok` apply whose landed bytes differ from intended) and
 *  `appliedUnverified` (the pipeline completed, but the settle-time CONTENT read
 *  threw so the divergence check could not run). The session wrapper and the
 *  rescue map 1:1 from these (see callers). */
export type DocumentWriteTag =
  // ⚠️ "pipeline ok" means the pipeline COMPLETED without failing, NOT that an
  // apply landed: the no-op short-circuit reaches `applied` / `appliedUnverified`
  // without ever calling `build` or `apply` (see `settle`'s ⚠️ note below), so on
  // that path there is no landing and no compare. `diverged` is the exception —
  // it is only reachable through a compare that actually ran.
  | "applied" // pipeline ok, settled content === intended (or nothing to apply) → reducer `ok`
  | "diverged" // apply ok, landed content !== intended → `ok` + divergedAfterApply
  | "appliedUnverified" // pipeline ok, the settle-time CONTENT read threw → `ok`, UNVERIFIED
  | "applyRefused" // apply resolved false → reducer `refused`
  | "buildThrew" // build() threw → reducer `constructThrew`
  | "applyThrew" // apply() threw synchronously → reducer `applyThrew`
  | "applyRejected"; // apply() promise rejected → reducer `rejected`

/** Immutable verified-write outcome. Carries the four verification-time
 *  snapshots so callers map WITHOUT re-reading the document. Contents are
 *  canonical (EOL-normalised to the document's EOL). EVERY terminal outcome —
 *  including `buildThrew`, which never touched the document — populates all four
 *  fields, but the two SETTLE-time ones are NULLABLE: `null` means the read threw
 *  and the value was NOT OBSERVED. Nullability is the verification discriminant,
 *  so every consumer is forced by the compiler to answer for the unobserved case
 *  rather than reading a fabricated value as a verified one.
 *  `message` (why the WRITE failed) is present only on the throw/reject tags;
 *  `settleReadFailure` (why the VERIFICATION is missing) is orthogonal to it and
 *  can accompany ANY tag.
 *
 *  ⚠️ The tag↔observation correlation is enforced at RUNTIME, not by this type.
 *  `{ tag: "applied", settledContent: null }` is representable here; two lines in
 *  `settle()`/`executeDocumentWrite` are what keep it from being CONSTRUCTED — the
 *  `applied → appliedUnverified` downgrade, and the `settledContent === null`
 *  early return that skips the divergence compare. Both are covered by tests
 *  (`execute-write.test.ts`'s "settle() is TOTAL" describe goes red if either is
 *  removed), so the gap is compile-time enforcement only. Making it structural
 *  means splitting this into a discriminated union (a content-observed arm that
 *  excludes `appliedUnverified`, an unobserved arm that excludes
 *  `applied`/`diverged` and requires `settleReadFailure`) — deliberately deferred:
 *  it is an exported type and the change ripples into every consumer and test
 *  fake, which is its own PR. */
export interface DocumentWriteOutcome {
  readonly tag: DocumentWriteTag;
  readonly intendedContent: string;
  readonly preApplyContent: string;
  /** null ⇔ `readCanonical()` threw — NOT OBSERVED, never fabricated. */
  readonly settledContent: string | null;
  /** null ⇔ `readVersion()` threw — NOT OBSERVED, never a numeric sentinel. */
  readonly settledVersion: number | null;
  /** Why the WRITE failed. */
  readonly message?: string;
  /** Why the VERIFICATION is missing. */
  readonly settleReadFailure?: string;
}

/** `err.message` / `String(err)` can THROW for an exotic rejection value (a
 *  throwing getter, a `toString` that raises). Since this now runs inside the
 *  verification catch — the one place whose whole job is to not propagate — the
 *  stringification is guarded too. Same guard `effect-executor.ts` applies for
 *  the same reason. */
function errorMessage(err: unknown): string {
  try {
    // `String(...)` wraps the WHOLE expression, not just the non-Error arm: an
    // `Error` whose `message` getter returns an object with a throwing
    // `toString` would otherwise escape as a non-string and blow up in the
    // caller's template literal — outside this guard.
    return String(err instanceof Error ? err.message : err);
  } catch {
    return "unknown error";
  }
}

/** Run the verified write pipeline. Async: the settlement is observed after the
 *  `apply` promise resolves. The SYNCHRONOUS prefix (readText → span → build →
 *  apply-initiation) runs before the first `await`, so the pre-apply snapshot is
 *  taken at call time in the SAME synchronous tick the caller invoked us — no
 *  inbound edit can interleave on the synchronous dispatch chain. The reducer
 *  caller (runApplyEdit) additionally holds the host write lock; the rescue
 *  caller (applyRestoreEdit) runs lock-free by design and relies on this same-
 *  tick property plus its own `isWriteLockHeld` skip-gate. Either way the
 *  freshness contract of the prior inline `runApplyEdit` is preserved. */
export async function executeDocumentWrite(
  adapter: DocumentWriteAdapter,
  content: string
): Promise<DocumentWriteOutcome> {
  // Pre-apply snapshot, taken synchronously in the caller's tick (see above:
  // the reducer path holds the write lock, the rescue path is lock-free but
  // same-tick — no inbound edit interleaves before the first await).
  const oldText = adapter.readText();
  const span = minimalEditSpan(oldText, content);

  // The two pre-apply snapshots the outcome always carries, canonicalised once
  // here (contract: every terminal outcome — including buildThrew — populates
  // all four fields, captured at verify time). `intendedContent` is the target
  // canonicalised to the document EOL, so the divergence check below is a direct
  // `===` against the equally-canonical settled read.
  const intendedContent = adapter.canonicalize(content);
  const preApplyContent = adapter.canonicalize(oldText);

  // Read the settled snapshot + tag the outcome. Wrapped in the `host:settle-
  // verify` perf stage (the canonical settled read is the O(n) cost the S3a
  // gate measured). Callers pass a PROVISIONAL tag, never a resolved one — there
  // is no "compare, then call `settle`" flow in this module, and `settle` is
  // never called with `"diverged"` at all. Two things resolve it afterwards:
  // `settle` itself downgrades `applied → appliedUnverified` when the content read
  // threw (see the ⚠️ note below), and the CALL SITE re-tags `diverged` with a
  // `{ ...settled, tag: "diverged" }` spread once it has both bytes to compare.
  // For the failure tags the settled read is the unchanged (or partially-changed)
  // document.
  //
  // TOTAL by construction: both verification reads are individually guarded. A
  // throw here used to reject the WHOLE pipeline, and since `ok = true` the apply
  // had already LANDED — so every caller's rejection arm reported a write that
  // SUCCEEDED as a failure ("Failed to save"), skipping the reducer's `ok`
  // self-advance. This layer is bounded post-hoc DETECTION (plan I5): when the
  // detection seam itself is unavailable, the honest answer is "landed,
  // UNVERIFIED", not "failed".
  //
  // An unread snapshot is `null` — NOT OBSERVED — never a fabricated value:
  //   - Synthesising `intendedContent` would make the reducer's drain gate ("the
  //     settled document IS edit #1's exact result") pass with no observation
  //     behind it, so a stash could clobber an external edit that the verified
  //     path deliberately lets win.
  //   - A numeric version sentinel (`-1`) would be assigned VERBATIM by the
  //     settlement `ok` self-advance and REWIND the version.
  // Every consumer is therefore forced by the compiler to answer for `null`, and
  // each answers conservatively: no self-advance, no epoch bump ("missing
  // snapshot ⇒ foreign" is a REJECTED variant — it drops the webview's replay
  // buffer), no drain.
  const settle = (tag: DocumentWriteTag, message?: string): DocumentWriteOutcome => {
    const verifyStart = QUOLL_PERF ? perfNow() : 0;
    const readFailures: string[] = [];
    let settledContent: string | null = null;
    try {
      settledContent = adapter.readCanonical();
    } catch (err) {
      readFailures.push(`readCanonical: ${errorMessage(err)}`);
    }
    let settledVersion: number | null = null;
    try {
      settledVersion = adapter.readVersion();
    } catch (err) {
      readFailures.push(`readVersion: ${errorMessage(err)}`);
    }
    if (QUOLL_PERF) {
      perfRecord("host:settle-verify", perfNow() - verifyStart);
    }
    return {
      // Only the `applied` tag downgrades: it is the sole tag whose meaning is a
      // CLAIM ABOUT THE SETTLED BYTES ("content === intended"), and without those
      // bytes the claim is unmade. Failure tags keep their own tag and message —
      // the primary cause is the triage payload.
      // ⚠️ `appliedUnverified` therefore means "the write pipeline completed
      // without failing, but the settled content was NOT OBSERVED" — NOT
      // literally "an apply landed". The no-op short-circuit below reaches
      // `settle("applied")` WITHOUT submitting an edit at all, so it can produce
      // this tag too. Every consumer treats it the same way (ok, no advance
      // without a version, no epoch bump, no drain), which is conservative in
      // both readings, so no consumer needs to tell them apart — but the tag's
      // name must not be read as a landing claim, and neither may the callers'
      // warn text.
      tag: settledContent === null && tag === "applied" ? "appliedUnverified" : tag,
      intendedContent,
      preApplyContent,
      settledContent,
      settledVersion,
      message,
      settleReadFailure: readFailures.length > 0 ? readFailures.join("; ") : undefined,
    };
  };

  // No-op short-circuit (defensive — the reducer already gates no-ops via the
  // canonical currentContent compare; only a mixed-EOL literal-buffer match
  // could reach here). Settle `applied` with the UNCHANGED document WITHOUT
  // submitting an empty WorkspaceEdit (the ok/refused of an empty edit is not
  // API-guaranteed). Never `diverged`: this path runs no compare at all. It yields
  // `applied`, or `appliedUnverified` if the settle-time content read throws — the
  // arrangement that makes `appliedUnverified` reachable with NOTHING applied.
  if (span.from === span.to && span.insert.length === 0) {
    return settle("applied");
  }

  let edit: unknown;
  try {
    // positionAt clamps out-of-range offsets (never throws) and minimalEditSpan
    // is pure — so buildThrew stays unreachable in practice; the arm is
    // preserved for parity and still carries the four snapshots.
    edit = adapter.build(span);
  } catch (err) {
    return settle("buildThrew", errorMessage(err));
  }

  let pending: Thenable<boolean>;
  const applyStart = QUOLL_PERF ? perfNow() : 0;
  try {
    pending = adapter.apply(edit);
  } catch (err) {
    // Synchronous apply throw: immediate failure, not a latency sample —
    // intentionally not recorded under host:applyEdit (parity with the prior
    // inline path).
    return settle("applyThrew", errorMessage(err));
  }

  let ok: boolean;
  try {
    ok = await Promise.resolve(pending);
  } catch (err) {
    if (QUOLL_PERF) {
      perfRecord("host:applyEdit", perfNow() - applyStart);
    }
    return settle("applyRejected", errorMessage(err));
  }
  if (QUOLL_PERF) {
    perfRecord("host:applyEdit", perfNow() - applyStart);
  }
  if (!ok) {
    return settle("applyRefused");
  }

  // Apply landed. POST-APPLY VERIFY: compare the canonical settled content
  // against the canonical intended content. Both are normalised to the document
  // EOL, so a direct `===` is exact (no EOL-insensitive compare needed here —
  // unlike the reducer's inFlight compare, whose operands differ in EOL form). A
  // mismatch means a racing edit spliced at a stale offset (S5: desktop
  // MISPLACES) OR an external edit won the apply→settle race — indistinguishable
  // by bytes, handled identically by convergence (diverged). The one
  // undetectable escape: a wrong splice whose final bytes coincidentally equal
  // the intended bytes (reported `applied`).
  const settled = settle("applied");
  if (settled.settledContent === null) {
    // `appliedUnverified` — nothing to compare. Never re-tag it `diverged`: that
    // forces the reducer's foreign-bytes verdict and drops the replay buffer.
    return settled;
  }
  return settled.settledContent === settled.intendedContent
    ? settled
    : { ...settled, tag: "diverged" };
}
