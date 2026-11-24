// Session-only memory of which editor surface each `.md` was last shown in —
// the Quoll rich editor (`"quoll"`) or the built-in text editor (`"text"`).
//
// DELIBERATELY in-memory only: plain module-level Maps, NO Memento /
// workspaceState / globalState / disk (user decision). A full VS Code host
// restart forgets everything, which is acceptable — the value is remembering
// within one working session. Bounded by the number of `.md` files touched in
// a session; entries are never evicted (a session-lifetime cache), mirroring
// the module-level store pattern of editor-switch-caret.ts.
//
// Writers. Deliberate selections supersede any outstanding claim:
//   - Reverse swaps use noteSurface after the target opens and before closing
//     the source.
//   - Forward swaps claim the URI when the switch is received and record the
//     outcome after finalize settles if the claim is still current.
//   - The tab watcher, through reconcileOpen, records deliberate Quoll opens.
// Text records never supersede a claim (they write the map directly):
//   - reconcileOpen adopts a fresh text open with no Quoll sibling as "text".
//   - When the last Quoll tab for a file closes and a text tab remains, the
//     watcher records "text" (noteTextLeftOpen).
// A text open beside a Quoll tab stays in place and records nothing.

export type EditorSurface = "quoll" | "text";

export interface OpenReconcile {
  /** Surface to record into memory (null = leave memory unchanged). */
  record: EditorSurface | null;
  /** Surface to reopen the doc in (null = leave the shown surface as-is). */
  reopen: EditorSurface | null;
}

const surfaces = new Map<string, EditorSurface>();
const generations = new Map<string, number>();

export interface SurfaceClaim {
  /** False once a newer deliberate selection for the same URI was recorded. */
  isCurrent(): boolean;
  /** Record the surface only while the claim is current. */
  record(surface: EditorSurface): void;
}

export function claimSurface(uriKey: string): SurfaceClaim {
  const generation = (generations.get(uriKey) ?? 0) + 1;
  generations.set(uriKey, generation);
  const isCurrent = () => generations.get(uriKey) === generation;
  return {
    isCurrent,
    record(surface) {
      if (isCurrent()) {
        surfaces.set(uriKey, surface);
      }
    },
  };
}

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
 *  sibling Quoll tab already exists. A text tab with a Quoll sibling stays
 *  open without changing memory, including when a stale swap's text-open event
 *  arrives after a deliberate Quoll open. A remembered `"text"` keeps a fresh
 *  text open in the text editor. */
export function decideOpenReconcile(
  remembered: EditorSurface | undefined,
  shown: EditorSurface,
  hasSibling: boolean
): OpenReconcile {
  if (shown === "text" && hasSibling) {
    return { record: null, reopen: null };
  }
  if (shown === "text" && remembered === "quoll") {
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
  // A Quoll open is always deliberate, so it supersedes any in-flight forward
  // swap claim. A text adopt is not, so it records without superseding.
  if (record === "quoll") {
    noteSurface(uriKey, record);
  } else if (record === "text") {
    surfaces.set(uriKey, record);
  }
  return reopen;
}

/** Record "text" because the last Quoll tab for `uriKey` closed while a text
 *  tab stays open — the surface left on screen is the remembered one. Like a
 *  text adopt, it does not supersede a claim: a forward swap's own close lands
 *  here first and its claim then records the same outcome. */
export function noteTextLeftOpen(uriKey: string): void {
  surfaces.set(uriKey, "text");
}

/** Record a deliberate selection for `uriKey` (a `Uri.toString()`) and
 *  supersede any outstanding claim for that URI. */
export function noteSurface(uriKey: string, surface: EditorSurface): void {
  claimSurface(uriKey).record(surface);
}

/** Test-only: read the remembered surface for `uriKey`, or undefined if none.
 *  Named with the `__…ForTest` convention because no production code reads
 *  memory directly — the watcher goes through `reconcileOpen`, the switch sites
 *  through `noteSurface` or `claimSurface`. */
export function __getRememberedSurfaceForTest(uriKey: string): EditorSurface | undefined {
  return surfaces.get(uriKey);
}

/** Test-only: clear both maps (the host-restart analogue). */
export function __clearSurfaceMemoryForTest(): void {
  surfaces.clear();
  generations.clear();
}
