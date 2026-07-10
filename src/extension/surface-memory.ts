// Session-only memory of which editor surface each `.md` was last shown in —
// the Quoll rich editor (`"quoll"`) or the built-in text editor (`"text"`).
//
// DELIBERATELY in-memory only: a plain module-level Map, NO Memento /
// workspaceState / globalState / disk (user decision). A full VS Code host
// restart forgets everything, which is acceptable — the value is remembering
// within one working session. Bounded by the number of `.md` files touched in
// a session; entries are never evicted (a session-lifetime cache), mirroring
// the module-level store pattern of editor-switch-caret.ts.
//
// Two writers feed it (see surface-restore-watcher.ts + the switch handlers):
//   - noteSurface: INTENT — a deliberate switch records the target surface once
//     the open SUCCEEDS and before the source tab is closed, so the tab watcher
//     adopts rather than bounces it.
//   - reconcileOpen: ENFORCEMENT — the tab watcher calls this for every newly
//     opened `.md` tab; it records the shown surface (adopt) or asks the caller
//     to reopen in the remembered surface (restore) without overwriting memory.

export type EditorSurface = "quoll" | "text";

export interface OpenReconcile {
  /** Surface to record into memory (null = leave memory unchanged). */
  record: EditorSurface | null;
  /** Surface to reopen the doc in (null = leave the shown surface as-is). */
  reopen: EditorSurface | null;
}

const surfaces = new Map<string, EditorSurface>();

/** Pure reconcile decision for a just-opened tab.
 *  - `remembered`: the stored surface for the doc, or undefined if none.
 *  - `shown`: the surface the just-opened tab is in.
 *  - `hasSibling`: true iff the SAME doc is already open in the OTHER surface —
 *    the signal of a deliberate side-by-side / mid-swap rather than a fresh
 *    reopen.
 *
 *  Restore is ASYMMETRIC (upgrade-to-Quoll only). Quoll's custom-editor priority
 *  is "option", so VS Code NEVER opens Quoll by default — a Quoll tab opening is
 *  therefore always an intentional choice (native Open With, our swap) and must
 *  be adopted, never bounced. Only a default TEXT open can be a fresh reopen that
 *  should be upgraded back to a remembered Quoll surface — and only when no
 *  sibling Quoll tab already exists (a sibling ⇒ a deliberate side-by-side or a
 *  toggle mid-swap ⇒ adopt the shown surface instead). Every other case adopts
 *  `shown` (a `"text"` memory is load-bearing: it says "do NOT re-upgrade to
 *  Quoll", so a file the user toggled to text stays text on reopen). */
export function decideOpenReconcile(
  remembered: EditorSurface | undefined,
  shown: EditorSurface,
  hasSibling: boolean
): OpenReconcile {
  if (shown === "text" && remembered === "quoll" && !hasSibling) {
    return { record: null, reopen: "quoll" };
  }
  return { record: shown, reopen: null };
}

/** Stateful entry point for the tab watcher: decide, apply the record to the
 *  in-memory map, and return the surface to reopen in (null = leave as-is). */
export function reconcileOpen(
  uriKey: string,
  shown: EditorSurface,
  hasSibling: boolean
): EditorSurface | null {
  const { record, reopen } = decideOpenReconcile(surfaces.get(uriKey), shown, hasSibling);
  if (record !== null) {
    surfaces.set(uriKey, record);
  }
  return reopen;
}

/** Record `surface` as the remembered surface for `uriKey` (a `Uri.toString()`),
 *  overwriting any prior. Called by the deliberate switch sites once they have
 *  opened the target surface (and before they close the source), so the tab
 *  watcher sees a match and adopts it. */
export function noteSurface(uriKey: string, surface: EditorSurface): void {
  surfaces.set(uriKey, surface);
}

/** Test-only: read the remembered surface for `uriKey`, or undefined if none.
 *  Named with the `__…ForTest` convention because no production code reads
 *  memory directly — the watcher goes through `reconcileOpen`, the switch sites
 *  through `noteSurface`. */
export function __getRememberedSurfaceForTest(uriKey: string): EditorSurface | undefined {
  return surfaces.get(uriKey);
}

/** Test-only: clear the whole map (the host-restart analogue). */
export function __clearSurfaceMemoryForTest(): void {
  surfaces.clear();
}
