// Inline POINT widget (Decoration.widget — NOT a block replace) rendering a
// "copy code" icon button absolutely positioned at the top-right of a fenced
// code block. The button is laid out by quollCopyButtonTheme (cm/theme.ts):
// `.cm-line.quoll-fenced-code-open` is position:relative so this absolutely-
// positioned button anchors to the panel's top-right corner. The button itself
// is out of flow (position:absolute), but CodeMirror wraps every inline widget
// in a zero-width `.cm-widgetBuffer` (height:1em) — so we do NOT claim "zero
// layout footprint"; the real-browser smoke (Task 5) confirms the open fence
// line's height is unchanged with the button present.
//
// Icon: Lucide (https://lucide.dev, MIT) `copy` glyph, swapping to `check` on a
// successful copy. The two glyphs are INLINED as static SVG built via
// createElementNS — per the project's supply-chain default-deny we don't add the
// `lucide` package for two static icons (and createElementNS avoids innerHTML, so
// there's no CSP/inline-style concern). The button is icon-only; aria-label is
// its accessible name.
//
// Display-only: the click handler copies text via navigator.clipboard and NEVER
// dispatches a document change, so the source round-trips byte-identically. The
// read-only gate lives in the builder (no widget is emitted at all when
// state.readOnly), so this DOM only ever exists on a writable surface.
//
// Copy feedback is ALSO announced to screen readers. The copy/failed state
// otherwise shows up only as a swap of the button's own aria-label, and a label
// change on an element that is not focused is not announced — so an SR user who
// clicks (or presses Enter on) the button gets no confirmation. toDOM therefore
// returns a wrapper holding the button PLUS a visually-hidden `aria-live` status
// node; the copy result is written into that region alongside the label swap
// (polite for success, assertive for the failure path). The region is a SIBLING
// of the button, not a child: a `role=button` subtree is often exposed atomically,
// so a live region nested inside it may never be observed — the banners
// (src/webview/banners.ts, role="alert") use the same standalone-region pattern.

import type { EditorState } from "@codemirror/state";
import { type EditorView, WidgetType } from "@codemirror/view";

const COPY_LABEL = "Copy code";
const COPIED_LABEL = "Copied";
const FAILED_LABEL = "Copy failed";
const COPIED_FEEDBACK_MS = 1500;

const SVG_NS = "http://www.w3.org/2000/svg";

// Lucide glyph path data (the parts that distinguish the two icons). `copy` also
// has a rect; `check` is a single path. Exported so the widget test can assert
// which glyph is currently shown.
export const COPY_ICON_PATH = "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2";
export const CHECK_ICON_PATH = "M20 6 9 17l-5-5";

type IconChild = { tag: "rect" | "path"; attrs: Record<string, string> };

const COPY_ICON: IconChild[] = [
  { tag: "rect", attrs: { width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2" } },
  { tag: "path", attrs: { d: COPY_ICON_PATH } },
];
const CHECK_ICON: IconChild[] = [{ tag: "path", attrs: { d: CHECK_ICON_PATH } }];

/** Build a Lucide-style 24×24 stroke SVG from its child shapes. */
function makeIcon(children: IconChild[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  })) {
    svg.setAttribute(k, v);
  }
  for (const child of children) {
    const el = document.createElementNS(SVG_NS, child.tag);
    for (const [k, v] of Object.entries(child.attrs)) {
      el.setAttribute(k, v);
    }
    svg.appendChild(el);
  }
  return svg;
}

/** Replace the button's glyph (icon-only button → single SVG child). */
function setIcon(button: HTMLButtonElement, children: IconChild[]): void {
  button.replaceChildren(makeIcon(children));
}

/** Announce a copy result in the visually-hidden live region. Setting the
 *  politeness BEFORE the text (assertive for the failure path, so a "Copy failed"
 *  interrupts) keeps the announcement's urgency in step with the text change. An
 *  empty message clears the region (on revert) so a subsequent identical copy is a
 *  fresh mutation and re-announces rather than being deduped as unchanged. */
function announce(status: HTMLElement, message: string, assertive: boolean): void {
  status.setAttribute("aria-live", assertive ? "assertive" : "polite");
  status.textContent = message;
}

/** Copy `text` via the webview-native Clipboard API. Returns true on success.
 *  No execCommand fallback: VS Code webview iframes grant clipboard-write, so
 *  navigator.clipboard.writeText is the available path; on the rare rejection we
 *  simply skip the "Copied" feedback rather than disturb the editor selection. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    console.warn("[quoll] copy to clipboard failed", err);
    return false;
  }
}

export class CopyButtonWidget extends WidgetType {
  constructor(
    /** Open-line offset of the fenced block — the sole eq() key. The button DOM is
     *  body- AND content-independent (a bare icon), so identity is purely
     *  positional: a body edit leaves openFrom fixed → the DOM (and its click
     *  handler) is REUSED with no per-keystroke body allocation; an edit above the
     *  block shifts openFrom → the DOM is rebuilt so the click resolves the block
     *  at its new offset. buildCopyButtons recomputes openFrom on every rebuild, so
     *  a reused handler's openFrom is always the live offset. */
    readonly openFrom: number,
    /** Lazy click-time body resolver — a stable module-level fn (fencedCodeBodyAt)
     *  injected by the builder to avoid a widget↔builder import cycle. Called with
     *  the LIVE state on click, so it returns the CURRENT body of the block at
     *  openFrom (or null if the block is gone), never a stale build-time payload. */
    readonly getBody: (state: EditorState, openFrom: number) => string | null
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof CopyButtonWidget && other.openFrom === this.openFrom;
  }

  toDOM(view: EditorView): HTMLElement {
    // Wrapper hosts the button PLUS a sibling live region (see the header). It is
    // NOT a positioning context (default static), so the absolutely-positioned
    // button still anchors to the `.cm-line.quoll-fenced-code-open` panel row, not
    // the wrapper. Both children sit out of flow (button absolute, region
    // visually-hidden absolute), so the wrapper contributes zero layout.
    const wrap = document.createElement("span");
    wrap.className = "quoll-copy-button-wrap";

    const button = document.createElement("button");
    button.type = "button";
    // Class name matches the theme selector in cm/theme.ts (copyButtonThemeSpec).
    button.className = "quoll-copy-button";
    button.setAttribute("aria-label", COPY_LABEL);
    setIcon(button, COPY_ICON);

    // Visually-hidden polite live region: empty at build time (present in the DOM
    // before any text lands, so the first write is an observable mutation SRs
    // announce). aria-atomic so the whole short phrase is read as a unit. The copy
    // handler flips it to assertive for the failure path.
    const status = document.createElement("span");
    status.className = "quoll-copy-status";
    status.setAttribute("aria-live", "polite");
    status.setAttribute("aria-atomic", "true");

    let revertTimer: ReturnType<typeof setTimeout> | undefined;
    // Last-click-wins guard: clipboard promises can settle OUT OF ORDER (a slow
    // reject from click N-1 arriving after a fast resolve from click N would
    // otherwise overwrite "Copied" with "Copy failed"). Each click captures its
    // own id; a settle whose id is stale is ignored.
    let attempt = 0;

    // mousedown: block CodeMirror's caret-on-mousedown so clicking the button
    // never moves the selection into the (hidden) fence line. preventDefault on
    // mousedown does NOT cancel the subsequent click, so keyboard Enter/Space
    // (which fires click WITHOUT mousedown) still activates the button.
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      // Resolve the CURRENT body at click time from the live state (view.state is
      // a getter — always current, even for a DOM reused across edits). null → the
      // block was deleted/reshaped since the last rebuild; nothing to copy, and we
      // leave the button's feedback state untouched (no attempt bump, no timer).
      const text = this.getBody(view.state, this.openFrom);
      if (text === null) {
        return;
      }
      const myAttempt = ++attempt;
      // Cancel a pending revert from a PRIOR click immediately, so it cannot
      // fire and flash the button back to the default "Copy code" state while
      // THIS click's clipboard promise is still in flight (the stale timer
      // would otherwise resolve between this click and its settle).
      if (revertTimer !== undefined) {
        clearTimeout(revertTimer);
        revertTimer = undefined;
      }
      void copyToClipboard(text).then((ok) => {
        // Drop a superseded (out-of-order) settle so the newest click wins.
        if (myAttempt !== attempt) {
          return;
        }
        // Symmetric feedback: success → check glyph + "Copied"; failure →
        // keep the copy glyph but flag "Copy failed" in the error colour. A
        // clipboard rejection (permission denied / no recent user activation
        // on vscode.dev) must NOT be silent — the user pressed a button and
        // gets a visible result either way. Showing the failure state never
        // disturbs the editor selection (it only touches this button).
        if (revertTimer !== undefined) {
          clearTimeout(revertTimer);
        }
        if (ok) {
          setIcon(button, CHECK_ICON);
          button.setAttribute("aria-label", COPIED_LABEL);
          button.classList.remove("is-copy-failed");
          button.classList.add("is-copied");
          // Polite: a success needn't interrupt the SR's current utterance.
          announce(status, COPIED_LABEL, false);
        } else {
          button.setAttribute("aria-label", FAILED_LABEL);
          button.classList.remove("is-copied");
          button.classList.add("is-copy-failed");
          // Assertive: the copy the user asked for did NOT happen — surface it now.
          announce(status, FAILED_LABEL, true);
        }
        revertTimer = setTimeout(() => {
          // Safe even if the widget DOM was discarded mid-timeout: this only
          // mutates the button's own (possibly detached) glyph/attrs + the live
          // region text — no view access, mirroring image-widget's post-discard
          // load listener. Clearing the region (back to polite) lets a later
          // identical copy re-announce instead of being deduped as unchanged.
          setIcon(button, COPY_ICON);
          button.setAttribute("aria-label", COPY_LABEL);
          button.classList.remove("is-copied", "is-copy-failed");
          announce(status, "", false);
        }, COPIED_FEEDBACK_MS);
      });
    });

    wrap.append(button, status);
    return wrap;
  }

  ignoreEvent(): boolean {
    // Our own listeners drive the copy; CM must not synthesize a state update
    // from widget-originated events.
    return true;
  }
}
