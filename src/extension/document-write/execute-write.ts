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
// restore bytes it clobbered; it detects the divergence (up to a coincidental
// byte-match escape) and lets every caller converge on one authoritative state.
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
 *  diverged). `readText` / `readVersion` / `readCanonical` / `canonicalize` are
 *  assumed non-throwing (as `document.getText/version` + the canonicalisers are
 *  today — they run OUTSIDE the build/apply try blocks). */
export interface DocumentWriteAdapter {
  readText: () => string;
  readVersion: () => number;
  readCanonical: () => string;
  canonicalize: (text: string) => string;
  build: (span: MinimalEditSpan) => unknown;
  apply: (edit: unknown) => Thenable<boolean>;
}

/** Complete outcome tag set — one per today's five `ApplyEditOutcome` kinds,
 *  plus `diverged` (an `ok` apply whose landed bytes differ from intended). The
 *  session wrapper and the rescue map 1:1 from these (see callers). */
export type DocumentWriteTag =
  | "applied" // apply ok, landed content === intended → maps to reducer `ok`
  | "diverged" // apply ok, landed content !== intended → `ok` + divergedAfterApply
  | "applyRefused" // apply resolved false → reducer `refused`
  | "buildThrew" // build() threw → reducer `constructThrew`
  | "applyThrew" // apply() threw synchronously → reducer `applyThrew`
  | "applyRejected"; // apply() promise rejected → reducer `rejected`

/** Immutable verified-write outcome. Carries the four verification-time
 *  snapshots so callers map WITHOUT re-reading the document. Contents are
 *  canonical (EOL-normalised to the document's EOL); `settledVersion` is the
 *  document version read at verify time. `message` is present only on the
 *  throw/reject tags. EVERY terminal outcome — including `buildThrew`, which
 *  never touched the document — populates all four snapshots. */
export interface DocumentWriteOutcome {
  readonly tag: DocumentWriteTag;
  readonly intendedContent: string;
  readonly preApplyContent: string;
  readonly settledContent: string;
  readonly settledVersion: number;
  readonly message?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  // gate measured). For `applied`/`diverged` the caller passes the resolved tag
  // after comparing; for the failure tags the settled read is the unchanged (or
  // partially-changed) document.
  const settle = (tag: DocumentWriteTag, message?: string): DocumentWriteOutcome => {
    const verifyStart = QUOLL_PERF ? perfNow() : 0;
    const settledContent = adapter.readCanonical();
    const settledVersion = adapter.readVersion();
    if (QUOLL_PERF) {
      perfRecord("host:settle-verify", perfNow() - verifyStart);
    }
    return { tag, intendedContent, preApplyContent, settledContent, settledVersion, message };
  };

  // No-op short-circuit (defensive — the reducer already gates no-ops via the
  // canonical currentContent compare; only a mixed-EOL literal-buffer match
  // could reach here). Settle `applied` with the UNCHANGED document WITHOUT
  // submitting an empty WorkspaceEdit (the ok/refused of an empty edit is not
  // API-guaranteed). settledContent === intendedContent here, so never diverged.
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
  return settled.settledContent === settled.intendedContent
    ? settled
    : { ...settled, tag: "diverged" };
}
