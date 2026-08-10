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

// Exported for unit tests (test/webview/cm-image-paste.test.ts) to seed/inspect
// pending anchors without driving real DOM paste/drop events.
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
    // on re-paste), which is correct vs. inserting at a wrong spot. BUT a
    // same-content reseed (applyDocument with needsReseed=false: a version/
    // canWrite-only ack) carries the annotation WITHOUT a doc change — positions
    // are unchanged, so anchors must be KEPT (else a paste + keep-typing whose
    // edit acks mid-round-trip would silently lose its image link). Gate the
    // clear on tr.docChanged.
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
  // "swallows a clearPending dispatch that fails after the view was destroyed"
  // test) — so this catch pins the contract against a future CM regression rather
  // than handling a hazard that reproduces today. It stays silent by design: the
  // caller has already logged, and a torn-down view has no state left to leak.
  // The transaction carries effects only, so `pendingImageAnchors`' update() (which
  // just filters) is the sole state work it can provoke — unlike resolve()'s insert,
  // there are no `changes` here to drive the widget/fold/lint fields that can throw.
  const clearPending = (view: EditorView, requestId: string): void => {
    try {
      view.dispatch({ effects: removePendingAnchor.of(requestId) });
    } catch {
      // view destroyed mid-round-trip — pending state dies with it.
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
        clearPending(view, requestId);
        return;
      }
      const comma = result.indexOf(",");
      const base64 = comma >= 0 ? result.slice(comma + 1) : "";
      if (base64 === "") {
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
      console.error("[quoll] failed to read pasted image");
      clearPending(view, requestId);
    };
    reader.readAsDataURL(file);
  };

  // Caller contract: invoked only with files.length > 0 AND canWrite() === true,
  // after the caller has already preventDefault'd the event. Submits each
  // in-cap image; returns true so the event stays handled even when every file
  // is gross-oversized (stops the browser navigating to a dropped file).
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
      return; // unknown / duplicate / already-resolved / cleared by a reseed
    }
    if (relativePath === null || !opts.canWrite()) {
      // Host rejected (toast already shown) OR doc went read-only mid-round-trip:
      // clear the anchor without inserting (avoid a link edit-sync would drop).
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
    const logInsertFailure = (label: string, err: unknown): void => {
      console.error(`[quoll] pasted image link insert failed: ${label}`, {
        err,
        requestId,
        anchor,
        relativePath,
        docLength: view.state.doc.length,
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
      // Deliberately NOT labelled "stale anchor": `EditorView.update` runs
      // `updatePlugins` / `docView.update` inside its own try whose finally only
      // resets updateState (only updateListener callbacks get logException), so a
      // throw from ANY unrelated field or plugin processing this insert — widgets,
      // fold, table, lint — surfaces right here. Naming the dispatch instead of the
      // anchor keeps that case from sending the next reader after the wrong bug.
      logInsertFailure("dispatch threw", err);
      clearPending(view, requestId);
    }
  };

  return { extension, resolve };
}
