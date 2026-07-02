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
    /** Absolute doc offset of the widget anchor (the open fence line.from). */
    readonly docFrom: number,
    /** The exact code body copied on click — in eq() so a body edit rebuilds
     *  the DOM (and its handler closure) with the fresh payload. */
    readonly body: string,
    /** True when the block has exactly ONE body line, so the panel collapses to
     *  a single visible row. Adds the `quoll-copy-button-single-line` marker the
     *  theme uses to vertically CENTRE the button on that lone row (scoped to the
     *  concealed-fence display state via the parent line's class — see
     *  cm/theme.ts copyButtonThemeSpec). In eq() so a body edit that crosses the
     *  one-line boundary rebuilds the DOM with the right marker. */
    readonly singleLine = false
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof CopyButtonWidget &&
      other.docFrom === this.docFrom &&
      other.body === this.body &&
      other.singleLine === this.singleLine
    );
  }

  toDOM(_view: EditorView): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    // Class name matches the theme selector in cm/theme.ts (copyButtonThemeSpec).
    button.className = this.singleLine
      ? "quoll-copy-button quoll-copy-button-single-line"
      : "quoll-copy-button";
    button.setAttribute("aria-label", COPY_LABEL);
    setIcon(button, COPY_ICON);

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
      const myAttempt = ++attempt;
      // Cancel a pending revert from a PRIOR click immediately, so it cannot
      // fire and flash the button back to the default "Copy code" state while
      // THIS click's clipboard promise is still in flight (the stale timer
      // would otherwise resolve between this click and its settle).
      if (revertTimer !== undefined) {
        clearTimeout(revertTimer);
        revertTimer = undefined;
      }
      void copyToClipboard(this.body).then((ok) => {
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
        } else {
          button.setAttribute("aria-label", FAILED_LABEL);
          button.classList.remove("is-copied");
          button.classList.add("is-copy-failed");
        }
        revertTimer = setTimeout(() => {
          // Safe even if the widget DOM was discarded mid-timeout: this only
          // mutates the button's own (possibly detached) glyph/attrs — no view
          // access, mirroring image-widget's post-discard load listener.
          setIcon(button, COPY_ICON);
          button.setAttribute("aria-label", COPY_LABEL);
          button.classList.remove("is-copied", "is-copy-failed");
        }, COPIED_FEEDBACK_MS);
      });
    });

    return button;
  }

  ignoreEvent(): boolean {
    // Our own listeners drive the copy; CM must not synthesize a state update
    // from widget-originated events.
    return true;
  }
}
