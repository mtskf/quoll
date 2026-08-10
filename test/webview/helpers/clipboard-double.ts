// A `DataTransfer` stand-in for suites that drive real paste events.
//
// Shared rather than re-declared per suite because two handlers now read the SAME
// membership predicate — `isIngestibleImageItem` (cm/image/image-paste.ts) decides
// both what imagePaste ingests and what richHtmlPaste may defer to it. A double
// that drifted between suites would let one of them pass on a clipboard shape the
// other could never construct, which is the test-side version of exactly the bug
// sharing that predicate removes.
//
// Shaped like the real thing in one way that matters: `items` carries a
// `kind: "string"` entry for EVERY text flavour present, as a browser's
// DataTransfer does, so a scan that walks `items` is exercised against a clipboard
// that can actually occur. Before this, `items` held file entries only.

/** One FILE entry. Omit `file` for a real File; state it explicitly as `null` OR
 *  `undefined` to model the item that matches on kind+type yet yields nothing.
 *  imagePaste's `if (file)` declines both spellings, so anything mirroring its
 *  acceptance has to decline both — and a handler that gets this wrong defers into
 *  a decline and lets CM's `doPaste("")` delete the selection. */
export type FileItemSpec = { type: string; file?: File | null | undefined };

export type ClipboardFlavours = {
  html?: string;
  text?: string;
  uriList?: string;
  files?: FileItemSpec[];
};

/** A file item carrying a real File — the shape imagePaste ingests. */
export const IMAGE_FILE: FileItemSpec[] = [{ type: "image/png" }];

/** Build the `clipboardData` / `dataTransfer` object for a synthetic paste or drop.
 *
 *  ⚠️ `getAsFile()` returns null for every `kind: "string"` item, per the DOM spec.
 *  That is also why `isIngestibleImageItem`'s `kind === "file"` test cannot be made
 *  independently non-vacuous from here: a SPEC-CONFORMANT non-file item already
 *  fails its `getAsFile()` condition, so dropping the `kind` test changes no
 *  observable behaviour. Making it observable would need a double that violates the
 *  spec, which would pin a clipboard the browser never produces. The `kind` test is
 *  a short-circuit matching the DOM contract, not a load-bearing condition. */
export function makeClipboardData(data: ClipboardFlavours): {
  getData: (type: string) => string;
  items: DataTransferItem[];
  files: File[];
  types: string[];
} {
  const store = new Map<string, string>();
  if (data.html !== undefined) {
    store.set("text/html", data.html);
  }
  if (data.text !== undefined) {
    store.set("text/plain", data.text);
  }
  if (data.uriList !== undefined) {
    store.set("text/uri-list", data.uriList);
  }

  const stringItems = Array.from(store.keys()).map((type) => ({
    kind: "string" as const,
    type,
    getAsFile: () => null,
  }));
  const fileItems = (data.files ?? []).map((spec) => ({
    kind: "file" as const,
    type: spec.type,
    // `"file" in spec`, not `spec.file === undefined`: the latter cannot tell an
    // omitted key from an explicit `file: undefined`, which is one of the two
    // no-File shapes this helper exists to be able to construct.
    // Non-empty content deliberately: imagePaste skips a zero-byte file (`file.size
    // === 0`), so a `new File([""], …)` default would make every ingestion test
    // pass the membership predicate and then silently do nothing.
    getAsFile: () => ("file" in spec ? spec.file : new File(["x"], "f", { type: spec.type })),
  }));

  const files = fileItems.map((item) => item.getAsFile()).filter((f): f is File => !!f);
  return {
    // Exact-type lookup only: the legacy aliases a real DataTransfer resolves
    // ("Text" → text/plain, "URL" → text/uri-list) are NOT mapped. CM's builtin drop
    // handler reads "Text", so it sees nothing here and declines a text-only drop;
    // a real browser would resolve the alias and consume that drop instead. This is
    // the canonical statement of that caveat — cm-image-paste.test.ts's text-only
    // drop test rests on the `defaultPrevented === false` baseline it produces, so
    // making this spec-accurate flips that baseline.
    getData: (type: string) => store.get(type) ?? "",
    // Cast at the boundary only: these doubles implement the three members the
    // production scans read (kind / type / getAsFile), not the whole interface.
    items: [...stringItems, ...fileItems] as unknown as DataTransferItem[],
    files,
    // A real DataTransfer reports "Files" alongside the text flavours whenever it
    // carries any file entry — the list imagePaste's dragover guard reads.
    types: [...store.keys(), ...(files.length > 0 ? ["Files"] : [])],
  };
}

/** Dispatch a synthetic `paste` at `target` and return the event. A plain `Event`
 *  with `clipboardData` defined onto it, so paste and drop are built the same way;
 *  happy-dom's ClipboardEvent would accept `clipboardData` from its init, but `drop`
 *  has no such route (see `fireDropAt`) and uniformity is worth more here. */
export function firePasteAt(target: EventTarget, data: ClipboardFlavours): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: makeClipboardData(data) });
  target.dispatchEvent(event);
  return event;
}

/** Dispatch a synthetic `drop` at `target`. `Event` rather than `DragEvent` because
 *  happy-dom has no DragEvent implementation at all — `BrowserWindow.js` exposes the
 *  bare alias `DragEvent = Event`, which carries no `dataTransfer`, `clientX` or
 *  `clientY` to set from the constructor or anywhere else. Defining the three
 *  properties onto a cancellable Event is the only route until happy-dom ships a
 *  real DragEvent.
 *
 *  ⚠️ The production drop handler calls `view.posAtCoords`, which under happy-dom
 *  (no layout engine) THROWS at SOME coordinates instead of returning a position —
 *  the `{0,0}` default below among them, while e.g. `{12,34}` returns one. Every
 *  caller must stub it — including read-only cases, where letting it throw makes
 *  the gate assertion vacuous. See cm-image-paste.test.ts's `stubDropPos`. */
export function fireDropAt(
  target: EventTarget,
  data: ClipboardFlavours,
  coords: { x: number; y: number } = { x: 0, y: 0 }
): Event {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: makeClipboardData(data) });
  Object.defineProperty(event, "clientX", { value: coords.x });
  Object.defineProperty(event, "clientY", { value: coords.y });
  target.dispatchEvent(event);
  return event;
}

/** Dispatch a synthetic `dragover` at `target`. The handler under test reads only
 *  `dataTransfer.types`, which `makeClipboardData` reports as a real DataTransfer
 *  does (a "Files" entry whenever any file item is present). */
export function fireDragOverAt(target: EventTarget, data: ClipboardFlavours): Event {
  const event = new Event("dragover", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: makeClipboardData(data) });
  target.dispatchEvent(event);
  return event;
}
