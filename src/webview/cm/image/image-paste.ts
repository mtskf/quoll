// Capture pasted/dropped image files and round-trip them through the host write
// path. Capture-only re: the host: this module posts `image-write` and, on the
// host's reply, inserts `![](relativePath)` at a position-mapped anchor. The
// insert rides the normal CM updateListener → edit-sync → host write pipeline.

import { type Extension, StateEffect, StateField } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DATA_LENGTH,
  PROTOCOL_VERSION,
  type WebviewToHost,
} from "../../../shared/protocol.js";
import { safePostMessage } from "../../safe-post-message.js";
import { hostDocumentReseed } from "../host-reseed.js";

const MAX_IMAGES_PER_EVENT = 16;
// Aggregate byte ceiling per paste/drop so a multi-file drop cannot queue an
// unbounded amount of base64 transient (16 × the transfer ceiling would
// otherwise be ~224 MiB). Once exceeded, remaining files in the event are
// dropped (console.warn).
const MAX_TOTAL_IMAGE_BYTES_PER_EVENT = 4 * MAX_IMAGE_BYTES; // 40 MiB

type PendingAnchor = { requestId: string; anchor: number };

// `addPendingAnchor` is exported so unit tests can seed pending anchors without driving
// real DOM paste/drop events — test/webview/image/cm-image-paste.test.ts and
// test/webview/shell.test.ts both do. `removePendingAnchor` is exported as the paired half
// of the same effect API; nothing outside this module dispatches it today.
export const addPendingAnchor = StateEffect.define<PendingAnchor>();
export const removePendingAnchor = StateEffect.define<string>(); // requestId

/** Tracks in-flight image-write anchors and maps each through doc changes so the
 *  link lands at the right place after the async host round-trip. Exported for
 *  unit tests. */
export const pendingImageAnchors = StateField.define<readonly PendingAnchor[]>({
  create: () => [],
  update(value, tr) {
    // A host reseed that ACTUALLY replaces the doc (wholesale 0..len) collapses
    // mapped anchors to the replace boundary (≈EOF). Drop all pending anchors —
    // the file is still written but the link is not inserted (orphan, idempotent
    // on re-paste), which is correct vs. inserting at a wrong spot. That orphan is
    // NOT silent: the reply still arrives, finds no anchor, and resolve() warns
    // with the path — which is why this clear does no logging of its own (it runs
    // inside a StateField update, has no relativePath to report, and would fire per
    // anchor rather than per outcome). BUT a same-content reseed (applyDocument
    // with needsReseed=false: a version/canWrite-only ack) carries the annotation
    // WITHOUT a doc change — positions are unchanged, so anchors must be KEPT (else
    // a paste + keep-typing whose edit acks mid-round-trip would silently lose its
    // image link). Gate the clear on tr.docChanged.
    // Note: a reseed transaction never also carries addPendingAnchor — paste and
    // reseed always dispatch separately — so early-returning here (skipping the
    // effects loop below) cannot drop a freshly-added anchor.
    if (tr.annotation(hostDocumentReseed)) {
      if (tr.docChanged) {
        return value.length === 0 ? value : [];
      }
      return value; // no-op reseed: positions intact, keep pending anchors
    }
    let next = value;
    if (tr.docChanged) {
      next = next.map((p) => ({ ...p, anchor: tr.changes.mapPos(p.anchor, 1) }));
    }
    for (const effect of tr.effects) {
      if (effect.is(addPendingAnchor)) {
        next = [...next, effect.value];
      } else if (effect.is(removePendingAnchor)) {
        next = next.filter((p) => p.requestId !== effect.value);
      }
    }
    return next;
  },
});

/** The single definition of "this clipboard item is an image this module will
 *  ingest". EXPORTED because richHtmlPaste (paste/rich-html-paste.ts) must defer
 *  to this handler on exactly this set and no wider: it runs FIRST, so deferring
 *  on a SUPERSET means this handler then declines, CM core falls through to
 *  `doPaste("")`, and the user's selection is replaced with nothing.
 *
 *  That handler used to restate the conditions instead of borrowing them, and TWO
 *  separate over-matches shipped into review before this became one definition:
 *  `files.length > 0` (which also matches a copied PDF), then
 *  `getAsFile() !== null` (which lets an `undefined` return through, where the
 *  `if (file)` below rejects it). A comment saying "MUST stay a SUBSET" is not a
 *  mechanism; one shared function is. Do NOT re-inline these conditions on either
 *  side — a caller that needs a NARROWER set should intersect this predicate with
 *  its own extra test, so the shared floor stays shared.
 *
 *  `kind === "file"` is first as a short-circuit matching the DOM contract; per
 *  spec a non-file item's `getAsFile()` already returns null, so it is
 *  belt-and-braces rather than the load-bearing condition. */
export function isIngestibleImageItem(item: DataTransferItem): boolean {
  return item.kind === "file" && item.type.startsWith("image/") && !!item.getAsFile();
}

function imageFilesFrom(dt: DataTransfer | null): File[] {
  if (!dt) {
    return [];
  }
  const files: File[] = [];
  for (const item of Array.from(dt.items)) {
    // Built FROM the shared predicate, not beside it: an acceptance change made
    // here without going through `isIngestibleImageItem` is exactly the drift that
    // deletes a selection over in richHtmlPaste.
    if (!isIngestibleImageItem(item)) {
      continue;
    }
    const file = item.getAsFile(); // non-null by the predicate; the check narrows the type
    if (file) {
      files.push(file);
    }
  }
  return files;
}

/** Estimated base64 length of `size` bytes — gross-oversized files are dropped
 *  before the (expensive) FileReader encode. */
function estimatedBase64Length(size: number): number {
  return Math.ceil(size / 3) * 4;
}

export function createImagePasteDrop(opts: {
  canWrite: () => boolean;
  post: (message: WebviewToHost) => void;
}): {
  extension: Extension;
  resolve: (view: EditorView, requestId: string, relativePath: string | null) => void;
} {
  let seq = 0;
  // Per-session nonce so requestIds never collide across a webview reload. A bare
  // counter resets to 1 on reload; a late image-write-result from the previous
  // session (same "1") would otherwise resolve a fresh pending anchor and insert
  // the wrong image path. With the nonce, a stale reply falls into resolve()'s
  // unknown-requestId no-op.
  const sessionNonce = crypto.randomUUID();

  // Dispatch guarded against a view torn down mid-round-trip (tab closed between
  // FileReader start and callback). CM 6.43 does NOT actually throw there —
  // `EditorView.update` early-returns on `this.destroyed` (measured; see the
  // "logs — but does not rethrow — a clearPending dispatch that fails after
  // teardown" test) — so this catch pins the contract against a future CM
  // regression rather than handling a hazard that reproduces today.
  //
  // It no longer stays silent. The catch was justified by "a destroyed view has
  // taken the pending state and the editor surface down with it, so there is no
  // outcome left for a reader to act on" — true of a destroyed view, but that is
  // NOT the only thing that can throw here. `view.dispatch` runs every StateField
  // in the editor, so an unrelated field throwing during an image-resolve dispatch
  // lands in this catch on a perfectly live view, where the pending entry then
  // survives and makes a re-paste look like a duplicate. Under today's CM the
  // destroyed-view case cannot even reach the catch (the measurement above), so
  // in practice a line printed from here means the OTHER cause — exactly the one
  // that was invisible. Whether the paste itself deserved a log is still each
  // caller's call, made before it gets here; this line reports only the failure of
  // the clear.
  // Every StateField still runs on this transaction — CM re-evaluates them all, not
  // just the ones an effect names. What makes it the safer dispatch is the absence of
  // `changes`: the widget/fold/lint fields see an unchanged doc and stay dormant,
  // whereas resolve()'s insert is what drives them through real work.
  const clearPending = (view: EditorView, requestId: string): void => {
    try {
      view.dispatch({ effects: removePendingAnchor.of(requestId) });
    } catch (err) {
      console.error("[quoll] failed to clear a pending image anchor", { err, requestId });
    }
  };

  const submit = (view: EditorView, file: File, anchor: number): void => {
    const requestId = `${sessionNonce}-${++seq}`;
    // Register the anchor BEFORE the async read so it maps from capture time.
    // Synchronous, inside the live event handler → no destroyed-view risk here.
    view.dispatch({ effects: addPendingAnchor.of({ requestId, anchor }) });
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        // Defensive: `readAsDataURL` is specified to yield a string, so this arm is
        // not reachable through a conforming browser. Logged anyway, for the same
        // reason clearPending's catch is: an unreachable branch that fires is
        // exactly the one nobody will guess at, and a paste that vanishes with no
        // trace is the failure this module keeps having.
        // `requestId` carried like every other log here: one paste event can start
        // several concurrent reads, and two bare copies of this line would be
        // indistinguishable — you could not tell which image of the batch died.
        console.warn("[quoll] dropped pasted image (FileReader returned a non-string result)", {
          requestId,
        });
        clearPending(view, requestId);
        return;
      }
      const comma = result.indexOf(",");
      const base64 = comma >= 0 ? result.slice(comma + 1) : "";
      if (base64 === "") {
        // Reachable only for a malformed data URL — a zero-byte file, the other way
        // to land an empty payload here, is already refused (with its own warn) back
        // in `handle`. Either way the paste is abandoned on a writable doc, so it says so.
        console.warn("[quoll] dropped pasted image (data URL carried no base64 payload)", {
          requestId,
        });
        clearPending(view, requestId);
        return;
      }
      const ok = safePostMessage(
        { postMessage: opts.post },
        { protocol: PROTOCOL_VERSION, type: "image-write", requestId, data: base64 },
        "image-write"
      );
      if (!ok) {
        clearPending(view, requestId);
      }
    };
    reader.onerror = () => {
      // No webview toast channel; rare browser-internal failure. Log + clear the
      // pending anchor so nothing leaks. (Documented in the security-audit note.)
      // `reader.error` is passed on because it is the ONLY account of the failure
      // that exists — a DOMException whose `name` separates NotReadableError (the
      // file moved/permissions) from the rest. It is metadata about the read, not
      // image content, so it is safe to log. Matches the policy in
      // `paste/html-to-markdown.ts`, which logs its caught `err` for the same reason.
      // Carried in the `{ err, requestId }` shape the rest of this file uses, for the
      // reason its siblings above do: concurrent reads from one paste event are only
      // tellable apart by requestId, and this is the arm most likely to hit several
      // at once (a batch dropped from a folder that then moves).
      console.error("[quoll] failed to read pasted image", { err: reader.error, requestId });
      clearPending(view, requestId);
    };
    reader.readAsDataURL(file);
  };

  // Caller contract: invoked only with files.length > 0 AND canWrite() === true, after the
  // caller has already preventDefault'd the event. Submits each in-cap image.
  //
  // The unconditional `true` states intent; it is not the mechanism. What actually stops
  // the browser navigating to a dropped file is the caller's preventDefault. Under CM 6.43
  // the return value is unobservable from here: `InputState.runHandlers` reacts to a truthy
  // handler by calling `event.preventDefault()` (already called) and breaking the handler
  // loop — which its own `if (event.defaultPrevented) break` would do on the next iteration
  // regardless. Kept as belt-and-braces, and because it is the honest answer to "did this
  // handler own the event?" on the branch where every file was refused.
  const handle = (view: EditorView, files: File[], anchor: number): boolean => {
    // Warned OUTSIDE the loop because this refusal is a property of the EVENT, not
    // of any one file: the overflow is discarded whole, so the loop never meets the
    // files it drops and could only ever report "and some more". Stated up front,
    // with the exact count, it is the one refusal a reader can act on directly.
    if (files.length > MAX_IMAGES_PER_EVENT) {
      const dropped = files.length - MAX_IMAGES_PER_EVENT;
      console.warn(
        `[quoll] dropped ${dropped} image(s) (per-event count cap of ${MAX_IMAGES_PER_EVENT} reached)`
      );
    }
    let totalBytes = 0;
    for (const file of files.slice(0, MAX_IMAGES_PER_EVENT)) {
      if (file.size === 0) {
        // The only refusal in this loop that used to be silent, and the one with the
        // widest blast radius. `handle` is shared by the paste and drop paths: on the
        // PASTE path `isIngestibleImageItem` never looks at size, so richHtmlPaste has
        // already deferred on this item; on the DROP path there is no such upstream.
        // Either way this handler then preventDefaults for the event, skips every file
        // and returns true — the event is fully consumed, nothing is inserted, and (on
        // paste) CM's plain-text fallback is suppressed too: a paste that vanishes with
        // no trace anywhere.
        //
        // Deliberately NOT hoisted into `isIngestibleImageItem`: the per-event
        // aggregate cap below is order-dependent and cannot live in a per-item
        // membership predicate at all, so hoisting the size refusals would only make
        // the shared floor LOOK like imagePaste's acceptance set while still not
        // being it. The predicate's honest contract is "this item is an image
        // candidate"; refusals belong in `handle`, and every one of them warns —
        // this loop's three plus the per-event count cap above it.
        console.warn("[quoll] dropped empty image file (zero bytes)");
        continue;
      }
      if (estimatedBase64Length(file.size) > MAX_IMAGE_DATA_LENGTH) {
        console.warn("[quoll] dropped oversized image (exceeds transfer ceiling)");
        continue;
      }
      if (totalBytes + file.size > MAX_TOTAL_IMAGE_BYTES_PER_EVENT) {
        console.warn("[quoll] dropped image (per-event aggregate byte cap reached)");
        break;
      }
      totalBytes += file.size;
      submit(view, file, anchor);
    }
    return true;
  };

  const extension: Extension = [
    pendingImageAnchors,
    EditorView.domEventHandlers({
      paste: (event, view) => {
        const files = imageFilesFrom(event.clipboardData);
        if (files.length === 0) {
          return false; // no image — let CM handle normal text paste
        }
        event.preventDefault(); // image files present — we own this event
        if (!opts.canWrite()) {
          return true; // read-only: swallow without writing
        }
        return handle(view, files, view.state.selection.main.head);
      },
      dragover: (event) => {
        if (event.dataTransfer && Array.from(event.dataTransfer.types).includes("Files")) {
          event.preventDefault(); // allow the drop event to fire for file drags
        }
        return false;
      },
      drop: (event, view) => {
        const files = imageFilesFrom(event.dataTransfer);
        if (files.length === 0) {
          return false;
        }
        event.preventDefault(); // image file drop — never let the browser open it
        if (!opts.canWrite()) {
          return true; // read-only: swallow without writing
        }
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        return handle(view, files, pos ?? view.state.selection.main.head);
      },
    }),
  ];

  const resolve = (view: EditorView, requestId: string, relativePath: string | null): void => {
    const pending = view.state.field(pendingImageAnchors).find((p) => p.requestId === requestId);
    if (!pending) {
      // unknown / duplicate / already-resolved / cleared by a reseed. The last of
      // those is the common one and the one with a cost: a wholesale reseed drops
      // every anchor (it cannot map them through a full-document replace), and by
      // the time the reply lands the host has ALREADY written the image. Not
      // inserting is right — the position could not be verified — but the file then
      // sits in the workspace with nothing pointing at it, so the outcome is named
      // here. `relativePath` is what makes the line actionable: a path IS the orphan.
      // A `null` path is logged too rather than skipped — see the arm below for why
      // "the host refused, so it reported it" does not hold in general.
      // The message states the outcome rather than the cause: a late reply from a
      // previous webview session (the sessionNonce case) reaches this same branch
      // and is indistinguishable from here.
      console.warn("[quoll] image-write result had no pending anchor; no link inserted", {
        requestId,
        relativePath,
      });
      return;
    }
    if (relativePath === null) {
      // The host refused. This arm was silent on the theory that it had therefore
      // already told the user and left nothing behind — and BOTH halves of that are
      // false in cases the wire cannot distinguish, because `image-write-result`
      // carries `ok:false` with no reason:
      //   · not always reported — `image-write-budget.ts` latches `warned` on the
      //     first session-volume rejection (`onExceeded` fires exactly once), so a
      //     REPEAT cap rejection posts null having shown the user nothing at all.
      //   · not always empty-handed — the write-failure arm of
      //     `image-write-service.ts` rejects AFTER attempting the write, and
      //     `workspace.fs.writeFile` offers no atomicity, so a partial
      //     content-addressed file can already be on disk (that is exactly why the
      //     budget never refunds a failed write).
      // Most reject reasons DO showError, so this line is usually a duplicate of a
      // toast the user has seen. That is the cheap direction to be wrong in: a
      // duplicated line in a console nobody reads costs nothing, while trusting a
      // toast we cannot verify was shown loses the refusal entirely. No
      // `relativePath` to carry — there is no path on this arm.
      //
      // The wording says "did not complete" rather than "refused" BECAUSE of the
      // second bullet above: on the write-failure arm the host did not refuse at all
      // — it accepted, tried, and the filesystem lost. Naming a cause the wire never
      // sent would be the same overclaim this comment exists to retract.
      console.warn("[quoll] image write did not complete on the host; no link inserted", {
        requestId,
      });
      clearPending(view, requestId);
      return;
    }
    if (!opts.canWrite()) {
      // Split out from the arm above because the two are opposites, not variants:
      // here the write SUCCEEDED and the host said so, then the document flipped
      // read-only before the link could be inserted. The host has no reason to have
      // said anything — from its side this write went fine — so unlike the arm above
      // there is not even a toast that MIGHT have been shown. The image sits in the
      // workspace with nothing pointing at it, and `relativePath` is the only handle
      // on that orphan, so it is logged (a host-chosen workspace-relative path, never
      // image content). The insert itself must still not happen: edit-sync would drop it.
      console.warn(
        "[quoll] pasted image written but not linked: document went read-only mid round-trip",
        { requestId, relativePath }
      );
      clearPending(view, requestId);
      return;
    }
    const anchor = pending.anchor;
    // Both failure paths below share one recovery, because by the time resolve() runs
    // the host has ALREADY written the image into the workspace: swallowing either one
    // costs the user a stray asset file with no link and no trace, and — because
    // `removePendingAnchor` rides the very dispatch that can fail — a leaked entry
    // pinning a now-meaningless anchor, which makes a re-paste look like a duplicate.
    // So each catch logs and then clears the anchor on its OWN dispatch, which cannot
    // carry the same hazard (effects only, no positions; clearPending absorbs the
    // torn-down-view case). The resulting orphaned file is exactly what a wholesale
    // reseed already produces, and beats inserting at a position we could not verify.
    //
    // They are kept as two try blocks rather than one because they fail for unrelated
    // reasons and only a precise log can tell them apart afterwards. Each logs the
    // context the sibling handler in `list/list-indent-keymap.ts` established as the
    // house style for a dispatch failure — a bare `err` does not say WHICH pending
    // image, at what anchor, or how far that anchor sat from the end of the doc. The
    // context is identical between the two, so it is built in one place; only the
    // label (which of the two failures this is) varies per call site.
    //
    // `docLength` is snapshotted HERE rather than read at log time, so that both call
    // sites report the same thing: the length the anchor was measured against. The
    // dispatch catch must not re-read it, because a throw can land on either side of
    // the state commit — `ViewState.update` assigns `this.state` (what `view.state`
    // returns) as its FIRST statement, before `docView.update` runs — so a re-read
    // would mean pre-insert on one path and post-insert on the other, under one name.
    const docLengthBeforeInsert = view.state.doc.length;
    const logInsertFailure = (label: string, err: unknown): void => {
      console.error(`[quoll] pasted image link insert failed: ${label}`, {
        err,
        requestId,
        anchor,
        relativePath,
        docLength: docLengthBeforeInsert,
      });
    };
    let line: ReturnType<typeof view.state.doc.lineAt>;
    try {
      line = view.state.doc.lineAt(anchor);
    } catch (err) {
      // Position lookup, not the edit: `lineAt` throws a RangeError on an anchor left
      // stale past the doc end, and it runs BEFORE the dispatch is even built — which
      // is why it needs its own guard. Wrapped only around the dispatch, this escaped
      // into the shell's message handler.
      logInsertFailure("stale anchor", err);
      clearPending(view, requestId);
      return;
    }
    // Standalone block: break onto its own line when mid-line; always close with
    // a newline so the read-path renders it as a block image. Multiple images
    // from one event insert in completion order (see Design notes).
    const prefix = anchor === line.from ? "" : "\n";
    const insert = `${prefix}![](${relativePath})\n`;
    try {
      // resolve runs synchronously from the shell's `editor?.` null-guarded handler
      // (view alive), but guard the dispatch for symmetry with the async paths.
      view.dispatch({
        changes: { from: anchor, insert },
        selection: { anchor: anchor + insert.length },
        effects: removePendingAnchor.of(requestId),
        scrollIntoView: true,
      });
    } catch (err) {
      // Deliberately NOT labelled "stale anchor": this catch is not only about the
      // anchor. Building the transaction runs every StateField, and `EditorView.update`
      // then runs `docView.update` unguarded — so an unrelated field throwing on this
      // insert (block widgets are StateFields here by design, as are fold and lint)
      // surfaces at exactly this line. What never reaches us is anything CM catches on
      // our behalf and hands to `logException`: ViewPlugin updates and updateListener
      // callbacks both — so a failure in edit-sync, which rides a listener, shows up in
      // the console under CM's own label and not this one. Naming the dispatch rather
      // than the anchor keeps the next reader off the wrong scent.
      logInsertFailure("dispatch threw", err);
      clearPending(view, requestId);
    }
  };

  return { extension, resolve };
}
