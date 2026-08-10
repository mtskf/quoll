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
