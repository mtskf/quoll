// Prose space-advance metric. Publishes `--quoll-prose-space` — the rendered
// width of ONE space in the editor's proportional body font — so the list-hang
// geometry can size source-indentation columns in a unit that matches the
// rendered prefix instead of `ch`.
//
// Why: `.cm-content` renders body text in a PROPORTIONAL UI font
// (var(--vscode-font-family); theme.ts), where `1ch` (the `0` glyph) is ~2× a
// space. The list-hang `text-indent` pulls the first line by the source-column
// count; in `ch` that over-pulls, so wrapped continuation lines hang deeper
// than the first-line text (the nested-bullet over-indent bug). Measuring the
// actual space advance and feeding it to the geometry via this variable makes
// the pull match the rendered prefix for ANY font (monospace: space == `0`, so
// the value equals the `1ch` fallback and columns render at the same width).
//
// CM measure-phase, READ-ONLY `read`: a PERSISTENT hidden probe (created once,
// removed in destroy()) is appended to `view.dom` — NOT a per-measure
// append/remove, which would violate CM's read-phase "no DOM mutation" contract
// and corrupt sibling measure requests. The probe mirrors `.cm-content`'s font
// via the SAME CSS variables, so re-measuring it after a font change yields the
// new advance with no JS write in `read`.
//
// Re-measure trigger = constructor (mount) + `update.geometryChanged &&
// !docChanged`. This covers what MATTERS for first-correct-paint: initial
// mount, a hidden→visible transition (a 0-width background-tab editor that later
// shows — dimensions change → geometryChanged → MUST re-measure or it stays on
// the 1ch fallback), resize and zoom. The `!docChanged` gate skips the
// per-keystroke geometryChanged (the probe width is document-independent). It
// does NOT catch a live font-FAMILY swap that leaves line-height unchanged
// (Quoll pins line-height: 1.7, and CM only flags geometryChanged on a >0.3px
// line-height delta or a wrap-mode change — Codex round-4 H), nor a
// `--vscode-font-family` CSS-var change CM never observes — a DOCUMENTED
// out-of-scope gap with a follow-up TODO (robust fix: a ResizeObserver on a
// `display:inline-block` probe). It does not affect the reported open/view bug
// and self-heals on reload.
//
// Publishing the var changes padding-inline-start → the line's available width
// → soft-wrap point → line HEIGHT, but NOT scrollDOM size, so CM's own observers
// would leave its height map stale (Codex round-5 showstopper). After a real
// set/remove we therefore schedule ONE fresh `view.requestMeasure()` via a
// microtask (an in-write bare call is a no-op under CM's measureScheduled
// guard) so CM rebuilds its height map; it converges because the re-measure's
// probe width is unchanged → policy "none" → nothing re-schedules. A
// non-positive / non-finite measurement (no layout engine — happy-dom — /
// detached / hidden) publishes nothing, or retracts a stale value, so the
// stylesheet `1ch` fallback governs (fail-open to monospace) until the next
// geometryChanged re-measures (e.g. when a hidden editor becomes visible).
//
// NOTE: the probe mirrors `.cm-content`'s font-family + font-size — the tokens
// that drive list BODY text, which is default weight / normal letter-spacing.
// If list body typography ever gains weight / letter-spacing / font-variation,
// mirror those onto the probe too or the measured advance will drift.

import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

const PROP = "--quoll-prose-space";
const PROBE_SPACES = 20; // average over many glyphs → robust sub-pixel advance

/** Pure publish policy (extracted for layout-free unit testing): given a freshly
 *  measured space advance (px) and the value this plugin last published, decide
 *  what to do with the CSS var. A non-finite or `<= 0` width means "unusable"
 *  (no layout engine / detached / a near-zero `scaleX` blowing the divide up to
 *  Infinity) — retract a stale value, else no-op. */
export function nextProseSpacePublish(
  width: number,
  lastPublished: string | null
): { action: "set"; value: string } | { action: "remove" } | { action: "none" } {
  if (width > 0 && Number.isFinite(width)) {
    const value = `${width}px`;
    return value === lastPublished ? { action: "none" } : { action: "set", value };
  }
  // unusable: retract a previously-published value so the stylesheet `1ch`
  // fallback governs again; otherwise nothing to do.
  return lastPublished === null ? { action: "none" } : { action: "remove" };
}

export const proseSpaceMetric = ViewPlugin.fromClass(
  class {
    private readonly host: HTMLElement;
    private readonly probe: HTMLSpanElement;
    private lastPublished: string | null = null;
    private resyncQueued = false;
    private disposed = false;
    constructor(view: EditorView) {
      this.host = view.dom;
      // Persistent, hidden, absolutely-positioned probe. Font tokens mirror
      // .cm-content via the SAME CSS variables. Created via the view's own
      // ownerDocument (iframe/webview-safe).
      const probe = view.dom.ownerDocument.createElement("span");
      probe.className = "quoll-prose-probe";
      probe.setAttribute("aria-hidden", "true");
      probe.style.cssText =
        "position:absolute;visibility:hidden;top:-9999px;left:0;white-space:pre;" +
        "pointer-events:none;font-family:var(--vscode-font-family);" +
        "font-size:var(--vscode-font-size);";
      probe.textContent = " ".repeat(PROBE_SPACES);
      this.host.appendChild(probe);
      this.probe = probe;
      this.measure(view); // initial — covers first paint
    }
    update(u: ViewUpdate): void {
      // The probe's width depends only on the FONT, never on the document, so
      // re-measure only on a NON-edit geometry change: mount-after-layout, a
      // hidden→visible transition (0-width → real, which MUST re-measure or the
      // editor stays on the 1ch fallback), resize, zoom. `geometryChanged` is
      // also set on every docChanged, so the `!docChanged` gate avoids a
      // per-keystroke probe read. (Live font-FAMILY changes that leave
      // line-height unchanged are NOT caught here — a documented out-of-scope
      // gap; see the follow-up TODO.)
      if (u.geometryChanged && !u.docChanged) {
        this.measure(u.view);
      }
    }
    destroy(): void {
      this.disposed = true;
      // finally: retract our inline override even if remove() throws, so a
      // reused view.dom never keeps a stale value.
      try {
        this.probe.remove();
      } finally {
        this.host.style.removeProperty(PROP);
      }
    }
    private measure(view: EditorView): void {
      view.requestMeasure({
        key: this, // frame-dedup — must stay `this`, never change or omit
        read: (v): number => {
          // read-only: rect read + transform-scale normalisation to local CSS px
          const raw = this.probe.getBoundingClientRect().width / PROBE_SPACES;
          const scaleX = v.scaleX || 1;
          return scaleX > 0 ? raw / scaleX : raw;
        },
        write: (width: number, v: EditorView): void => {
          const decision = nextProseSpacePublish(width, this.lastPublished);
          if (decision.action === "set") {
            this.lastPublished = decision.value;
            v.dom.style.setProperty(PROP, decision.value);
          } else if (decision.action === "remove") {
            this.lastPublished = null;
            v.dom.style.removeProperty(PROP);
          } else {
            return; // no change → nothing to re-sync
          }
          // The var change alters padding-inline-start → the line's available
          // width → soft-wrap point → line HEIGHT, but does NOT change scrollDOM
          // size, so CM's own observers won't re-measure and its height map goes
          // stale (Codex round-5 showstopper). Schedule ONE fresh measure AFTER
          // this write flush — a bare requestMeasure() DURING write is a no-op
          // (CM's measureScheduled guard), so defer via microtask — so CM
          // rebuilds its height map against the new padding. That re-measure
          // re-runs CM's own DOM measurement, NOT our keyed read/write; the
          // probe width is unchanged → if it triggers a follow-up geometryChanged
          // our update() re-measures, the policy returns "none", and nothing
          // re-schedules (converges). `resyncQueued` coalesces; `disposed` guards
          // a microtask that outlives destroy().
          if (!this.resyncQueued) {
            this.resyncQueued = true;
            queueMicrotask(() => {
              this.resyncQueued = false;
              if (!this.disposed) {
                v.requestMeasure();
              }
            });
          }
        },
      });
    }
  }
);
