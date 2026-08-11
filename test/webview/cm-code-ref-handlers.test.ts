// @vitest-environment happy-dom
import { markdown } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import {
  CODE_REF_OPEN_KEY,
  handleCodeRefClick,
  handleCodeRefMouseDown,
  openCodeRefAtCaretCommand,
  quollCodeRefClickHandler,
  tryOpenCodeRefAt,
} from "../../src/webview/cm/code-ref/code-ref-handlers.js";
import { codeRefReveal } from "../../src/webview/cm/code-ref/code-ref-reveal.js";
import { fullTree } from "./helpers/full-tree.js";

function stateFor(doc: string, sel?: number) {
  return EditorState.create({
    doc,
    extensions: [markdown()],
    selection: sel === undefined ? undefined : { anchor: sel },
  });
}

describe("tryOpenCodeRefAt", () => {
  it("posts open-code-reference for a path inside inline code", () => {
    const doc = "see `src/foo.ts:42` end";
    const host = { postMessage: vi.fn() };
    expect(tryOpenCodeRefAt(stateFor(doc), doc.indexOf("foo"), host as never)).toBe(true);
    expect(host.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "open-code-reference", path: "src/foo.ts", line: 42 })
    );
  });
  it("does not post for a non-path or .md inline code span", () => {
    const host = { postMessage: vi.fn() };
    expect(tryOpenCodeRefAt(stateFor("call `useState` now"), 8, host as never)).toBe(false);
    expect(tryOpenCodeRefAt(stateFor("see `a/b.md` x"), 6, host as never)).toBe(false);
    expect(host.postMessage).not.toHaveBeenCalled();
  });
  it("does not post for inline code inside a link (link owns the click)", () => {
    const doc = "[`src/foo.ts`](other.md)";
    const host = { postMessage: vi.fn() };
    expect(tryOpenCodeRefAt(stateFor(doc), doc.indexOf("foo"), host as never)).toBe(false);
  });
  it("does not post while the selection intersects the span (editing)", () => {
    const doc = "see `src/foo.ts` end";
    const host = { postMessage: vi.fn() };
    expect(
      tryOpenCodeRefAt(stateFor(doc, doc.indexOf("foo")), doc.indexOf("foo"), host as never)
    ).toBe(false);
  });
  it("does not post outside any inline code", () => {
    const host = { postMessage: vi.fn() };
    expect(tryOpenCodeRefAt(stateFor("plain src/foo.ts text"), 2, host as never)).toBe(false);
  });
  it("opens despite an intersecting selection when the defer guard is off (keyboard path)", () => {
    // The keyboard command targets a reference by putting the caret INSIDE it,
    // which self-intersects the span. With deferWhenSelectionIntersects=false the
    // open must still fire (unlike the mouse path pinned above).
    const doc = "see `src/foo.ts:42` end";
    const host = { postMessage: vi.fn() };
    expect(
      tryOpenCodeRefAt(stateFor(doc, doc.indexOf("foo")), doc.indexOf("foo"), host as never, {
        deferWhenSelectionIntersects: false,
      })
    ).toBe(true);
    expect(host.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "open-code-reference", path: "src/foo.ts", line: 42 })
    );
  });
});

describe("handleCodeRefMouseDown", () => {
  const DOC = "see `src/foo.ts:42` end";
  const REF_POS = DOC.indexOf("foo");

  type MockMouseEvent = MouseEvent & { preventDefault: ReturnType<typeof vi.fn> };

  // Mock EditorView shaped for handleCodeRefMouseDown: the helper reads only
  // `view.state` (for tryOpenCodeRefAt) and `view.posAtCoords` (coord → pos).
  // happy-dom has no layout, so a real view's posAtCoords cannot resolve a
  // meaningful position — the stub is what makes the mouse path testable at all.
  // Same seam as cm-link-handlers.test.ts's makeMockView. It is a spy, not a bare
  // arrow, so the coordinates handed to it can be asserted (see the second test).
  function makeMockView(state: EditorState, pos: number | null): EditorView {
    return { state, posAtCoords: vi.fn(() => pos) } as unknown as EditorView;
  }
  function makeMockEvent(button: number): MockMouseEvent {
    return {
      button,
      clientX: 100,
      clientY: 50,
      preventDefault: vi.fn(),
    } as unknown as MockMouseEvent;
  }

  it("opens the reference on a left-click and swallows the event", () => {
    const host = { postMessage: vi.fn() };
    const event = makeMockEvent(/* left */ 0);
    const view = makeMockView(stateFor(DOC), REF_POS);
    expect(handleCodeRefMouseDown(event, view, host as never)).toBe(true);
    expect(host.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "open-code-reference", path: "src/foo.ts", line: 42 })
    );
    // preventDefault only on the taken path — otherwise the click would not
    // reposition the caret on a plain (non-reference) mousedown.
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("resolves the click at the event's coordinates, in imprecise mode", () => {
    // The coordinate hand-off is the one job this handler does on its own —
    // everything downstream belongs to tryOpenCodeRefAt, which the describe above
    // already covers — so pin both halves of the posAtCoords call. Passing the
    // event's own coords is what makes the click land where the user clicked, and
    // the literal `false` selects the imprecise overload: precise mode returns
    // null when the clicked block falls outside the rendered viewport (CM 6.43
    // virtualises long documents), so in a long file a click could resolve to
    // nothing instead of opening. Imprecise mode estimates a position instead.
    // A stub that did not record its arguments would let both regressions
    // through unseen.
    const host = { postMessage: vi.fn() };
    const event = makeMockEvent(/* left */ 0);
    const view = makeMockView(stateFor(DOC), REF_POS);
    expect(handleCodeRefMouseDown(event, view, host as never)).toBe(true);
    expect(view.posAtCoords).toHaveBeenCalledWith({ x: 100, y: 50 }, false);
  });

  it("forwards the resolved position exactly (a reference's edges do not open)", () => {
    // Side-0 resolution enters InlineCode only strictly inside its 4..19 span, so
    // the opening backtick (4) and the offset just past the closing one (19) must
    // not open, while 5..18 do. That asymmetry is what makes this pin the seam
    // between posAtCoords and tryOpenCodeRefAt: a +1 slip turns pos 4 into an
    // open, a -1 slip turns pos 19 into one. Mid-token samples see neither.
    const host = { postMessage: vi.fn() };
    for (const pos of [DOC.indexOf("`"), DOC.lastIndexOf("`") + 1]) {
      const event = makeMockEvent(/* left */ 0);
      const view = makeMockView(stateFor(DOC), pos);
      expect(handleCodeRefMouseDown(event, view, host as never)).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(host.postMessage).not.toHaveBeenCalled();
  });

  it("ignores a right-click on a reference (never hijacks the context menu)", () => {
    const host = { postMessage: vi.fn() };
    const event = makeMockEvent(/* right */ 2);
    const view = makeMockView(stateFor(DOC), REF_POS);
    expect(handleCodeRefMouseDown(event, view, host as never)).toBe(false);
    expect(host.postMessage).not.toHaveBeenCalled();
    // A preventDefault here would suppress the browser context menu.
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("ignores a middle-click on a reference", () => {
    const host = { postMessage: vi.fn() };
    const event = makeMockEvent(/* middle */ 1);
    const view = makeMockView(stateFor(DOC), REF_POS);
    expect(handleCodeRefMouseDown(event, view, host as never)).toBe(false);
    expect(host.postMessage).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("defers while the selection intersects the reference (click lands mid-edit)", () => {
    // The mouse path takes tryOpenCodeRefAt's default
    // `deferWhenSelectionIntersects: true`, so a click on a reference the caret is
    // already inside repositions the caret instead of navigating away.
    const host = { postMessage: vi.fn() };
    const event = makeMockEvent(/* left */ 0);
    const view = makeMockView(stateFor(DOC, REF_POS), REF_POS);
    expect(handleCodeRefMouseDown(event, view, host as never)).toBe(false);
    expect(host.postMessage).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("never posts or throws for a null / out-of-range position", () => {
    // Scope note: this pins the OUTCOME (no post, no preventDefault, no throw),
    // NOT the `pos === null || pos < 0 || pos > doc.length` guard itself. That
    // guard cannot be falsified through this handler's contract — deleting it
    // outright leaves every case below still returning false, because
    // resolveInner clamps an out-of-range pos to a doc boundary that never
    // resolves into InlineCode (verified by mutation). Nor is it type-mandated:
    // the `precise: false` overload is typed `number`, not `number | null`, and
    // clamps to [0, doc.length] at runtime, so the guard — null arm included — is
    // pure defence in depth against an upstream contract change. Do not
    // "strengthen" this into a guard assertion; it would be permanently vacuous.
    const bare = "`src/foo.ts:42`"; // nothing but the reference: the widest target
    const host = { postMessage: vi.fn() };
    for (const pos of [null, -1, bare.length + 1]) {
      const event = makeMockEvent(/* left */ 0);
      const view = makeMockView(stateFor(bare), pos);
      expect(handleCodeRefMouseDown(event, view, host as never)).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(host.postMessage).not.toHaveBeenCalled();
  });

  it("leaves a left-click outside any reference to CodeMirror", () => {
    const host = { postMessage: vi.fn() };
    const event = makeMockEvent(/* left */ 0);
    const view = makeMockView(stateFor(DOC), 1); // inside "see"
    expect(handleCodeRefMouseDown(event, view, host as never)).toBe(false);
    expect(host.postMessage).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

describe("handleCodeRefClick", () => {
  // Render the REAL reveal span (`.quoll-code-ref-clickable`, role="link") into a
  // live view, so an AT-synthesized click can target the exact element a screen
  // reader activates. `posAtDOM` on that span resolves to a position INSIDE the
  // reference (the whole prose line is otherwise a single text node whose start is
  // outside the span), so this genuinely exercises the open path.
  function viewWithRefSpan(doc: string): EditorView {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const base = EditorState.create({ doc, extensions: [markdown()] });
    const revealSet = codeRefReveal.build({
      state: base,
      selection: base.selection,
      visibleRanges: [{ from: 0, to: doc.length }],
      tree: fullTree(base),
    });
    return new EditorView({
      state: EditorState.create({
        doc,
        extensions: [markdown(), EditorView.decorations.of(revealSet)],
      }),
      parent,
    });
  }
  function refSpan(view: EditorView): HTMLElement {
    const span = view.dom.querySelector<HTMLElement>(".quoll-code-ref-clickable");
    if (span === null) {
      throw new Error("expected a rendered .quoll-code-ref-clickable span");
    }
    return span;
  }

  it("opens on a synthesized (AT) click whose target is the role=link span", () => {
    const host = { postMessage: vi.fn() };
    const view = viewWithRefSpan("see `src/foo.ts:42` end");
    try {
      const ev = {
        detail: 0,
        target: refSpan(view),
        preventDefault: vi.fn(),
      } as unknown as MouseEvent;
      expect(handleCodeRefClick(ev, view, host as never)).toBe(true);
      expect(host.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "open-code-reference", path: "src/foo.ts", line: 42 })
      );
    } finally {
      view.destroy();
    }
  });
  it("ignores a real mouse click (detail>=1) so it never double-posts with mousedown", () => {
    const host = { postMessage: vi.fn() };
    const view = viewWithRefSpan("see `src/foo.ts:42` end");
    try {
      const ev = {
        detail: 1,
        target: refSpan(view),
        preventDefault: vi.fn(),
      } as unknown as MouseEvent;
      expect(handleCodeRefClick(ev, view, host as never)).toBe(false);
      expect(host.postMessage).not.toHaveBeenCalled();
    } finally {
      view.destroy();
    }
  });
});

describe("CODE_REF_OPEN_KEY", () => {
  it("is the Mod-Enter chord", () => {
    // Pin the chord string (the single source of truth for the keymap binding).
    // The real platform-resolved binding is exercised in manual smoke; happy-dom's
    // CM platform detection makes a synthetic-key runScopeHandlers test flaky.
    expect(CODE_REF_OPEN_KEY).toBe("Mod-Enter");
  });
});

describe("quollCodeRefClickHandler", () => {
  // The `handleCodeRefMouseDown` and `handleCodeRefClick` describes above call the
  // handlers directly, which leaves the binding itself — `mousedown`→mousedown
  // handler, `click`→click handler — unpinned. Either mutation of it keeps every
  // other test in the suite green:
  //   - swap the two keys → each event reaches the WRONG handler, so an AT click
  //     gets resolved by coordinates and a mousedown is refused outright
  //   - drop either key → that trigger silently stops opening references at all
  // What neither mutation does is double-post, despite the tempting symmetry of
  // the two gates (measured, not reasoned): with the keys swapped a real mousedown
  // is refused by `detail !== 0`, and the click that follows reaches the mousedown
  // handler, which opens at most once — and opens nothing at all once the caret has
  // landed inside the reference, since that handler defers on an intersecting
  // selection. So a swap costs you the open, never duplicates it. Double-posting is
  // held off by `detail !== 0` alone, which is what the third test below pins.
  // So these tests mount the REAL extension and dispatch REAL DOM events,
  // discriminating the handlers by the seam each uses to resolve a position: the
  // mousedown handler goes through `posAtCoords`, the click handler through
  // `posAtDOM`. Asserting on posAtCoords (called / not called) is what makes a
  // swap red rather than merely differently-green.
  const DOC = "see `src/foo.ts:42` end";
  const REF_POS = DOC.indexOf("foo");

  // happy-dom has no layout, so an unstubbed `posAtCoords` reaches through an
  // undefined client rect and THROWS at some coordinates rather than returning a
  // position (docs/LEARNING.md "2026-08-10: happy-dom の `view.posAtCoords` は座標
  // 次第で throw する" — coordinate-dependent, not "always throws"). The spy is
  // what makes the mouse path observable at all. Only that layout oracle is
  // stubbed; the extension, the view, and the event dispatch are all real.
  // ⚠️ The spy shields quoll's handler ONLY. CM's own mousedown selection resolves
  // through `posAndSideAtCoords` → the module-level `posAtCoords`, which no
  // instance stub can intercept, and which throws here. These tests never reach it
  // because the handler returns true and CM's `runHandlers` stops before the
  // built-in — so a mousedown this handler does NOT swallow (any negative-path
  // case) will crash inside CM rather than fail cleanly. Pin those on
  // `handleCodeRefMouseDown` directly, in the describe above, not here.
  function mountWithRefSpan() {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    // Owned here, not passed in, so the host asserted on is necessarily the one
    // wired into the mounted extension.
    const host = { postMessage: vi.fn() };
    const base = EditorState.create({ doc: DOC, extensions: [markdown()] });
    const revealSet = codeRefReveal.build({
      state: base,
      selection: base.selection,
      visibleRanges: [{ from: 0, to: DOC.length }],
      tree: fullTree(base),
    });
    const view = new EditorView({
      state: EditorState.create({
        doc: DOC,
        extensions: [
          markdown(),
          EditorView.decorations.of(revealSet),
          quollCodeRefClickHandler(host as never),
        ],
      }),
      parent,
    });
    const span = view.dom.querySelector<HTMLElement>(".quoll-code-ref-clickable");
    if (span === null) {
      view.destroy();
      throw new Error("expected a rendered .quoll-code-ref-clickable span");
    }
    // Same stubbing idiom as `stubDropPos` in test/webview/image/cm-image-paste.test.ts.
    const posAtCoords = vi.spyOn(view, "posAtCoords").mockReturnValue(REF_POS);
    return { view, span, host, posAtCoords };
  }

  it("routes a real mousedown to the mousedown handler (coord-resolved open)", () => {
    const { view, span, host, posAtCoords } = mountWithRefSpan();
    try {
      // A genuine left-button mousedown carries detail 1, which the click handler
      // rejects outright — so if the bindings were swapped nothing would post and
      // posAtCoords would never be consulted.
      span.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0, detail: 1, clientX: 8, clientY: 8 })
      );
      expect(posAtCoords).toHaveBeenCalled();
      expect(host.postMessage).toHaveBeenCalledTimes(1);
      expect(host.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "open-code-reference", path: "src/foo.ts", line: 42 })
      );
    } finally {
      view.destroy();
    }
  });

  it("routes a synthesized click to the click handler (DOM-target-resolved open)", () => {
    const { view, span, host, posAtCoords } = mountWithRefSpan();
    try {
      // An assistive-tech activation of the role="link" span arrives as a click
      // with detail 0 and button 0. The click handler resolves it through
      // posAtDOM; the mousedown handler would take the button-0 path and consult
      // posAtCoords instead, so the posAtCoords assertion below fails on a swap
      // even though both routes happen to post.
      span.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 0 }));
      expect(posAtCoords).not.toHaveBeenCalled();
      expect(host.postMessage).toHaveBeenCalledTimes(1);
      expect(host.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "open-code-reference", path: "src/foo.ts", line: 42 })
      );
    } finally {
      view.destroy();
    }
  });

  it("posts exactly once for a full mouse click (mousedown then click)", () => {
    // The two tests above dispatch one event each, so neither sees the pair a
    // browser actually emits for one click: mousedown (detail 1) followed by click
    // (detail 1), both landing on this same span. That pair is where double-posting
    // would show up, and `detail !== 0` in handleCodeRefClick is the only thing
    // stopping it — delete that gate and this sequence posts twice (measured),
    // while the other two tests in this describe, which dispatch a single event
    // each, stay green. This is the wiring-level statement of the contract the unit
    // test "ignores a real mouse click (detail>=1)" makes about the handler alone.
    const { view, span, host } = mountWithRefSpan();
    try {
      span.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0, detail: 1, clientX: 8, clientY: 8 })
      );
      span.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
      expect(host.postMessage).toHaveBeenCalledTimes(1);
      expect(host.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "open-code-reference", path: "src/foo.ts", line: 42 })
      );
    } finally {
      view.destroy();
    }
  });
});

describe("openCodeRefAtCaretCommand", () => {
  function viewWithCaret(doc: string, caret: number): EditorView {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    return new EditorView({
      state: EditorState.create({
        doc,
        selection: EditorSelection.single(caret),
        extensions: [markdown()],
      }),
      parent,
    });
  }

  it("posts open-code-reference when the caret is inside a reference", () => {
    const doc = "see `src/foo.ts:42` end";
    const host = { postMessage: vi.fn() };
    const view = viewWithCaret(doc, doc.indexOf("foo"));
    try {
      expect(openCodeRefAtCaretCommand(host as never)(view)).toBe(true);
      expect(host.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "open-code-reference", path: "src/foo.ts", line: 42 })
      );
    } finally {
      view.destroy();
    }
  });

  it("returns false and posts nothing when the caret is not in a reference", () => {
    const host = { postMessage: vi.fn() };
    const view = viewWithCaret("plain src/foo.ts text", 2);
    try {
      expect(openCodeRefAtCaretCommand(host as never)(view)).toBe(false);
      expect(host.postMessage).not.toHaveBeenCalled();
    } finally {
      view.destroy();
    }
  });
});
