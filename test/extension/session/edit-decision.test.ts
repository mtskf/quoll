import { describe, expect, it } from "vitest";

import { decideEdit } from "../../../src/extension/session/edit-decision.js";

describe("decideEdit", () => {
  const baseInput = {
    baseIsCurrent: true,
    canWrite: true,
    content: "# hello\n",
    currentContent: "different\n",
  };

  it("accepts changed content when the base is current and writable", () => {
    expect(decideEdit(baseInput).kind).toBe("accept");
  });

  it("rejects with kind=stale when the base is not the current text", () => {
    // The webview was editing on top of text the host no longer holds — the
    // host must NOT applyEdit; it resyncs by posting the current
    // authoritative Document on the call site. (Which versions count as
    // current is the reducer's decision — host-session-core.test.ts.)
    expect(decideEdit({ ...baseInput, baseIsCurrent: false }).kind).toBe("stale");
  });

  it("rejects with kind=readonly when canWrite=false", () => {
    // Readonly trumps everything else: do not even parse the content.
    expect(decideEdit({ ...baseInput, canWrite: false }).kind).toBe("readonly");
  });

  it("evaluates readonly BEFORE stale when both fail", () => {
    // Order pin: readonly is cheap and definitive; stale is also cheap
    // but readonly comes first so a readonly Edit on a stale base does
    // not surface as a stale verdict. Both produce a resync at the panel
    // call site, so the user-visible behaviour is the same — but the
    // panel may log/branch on the verdict and a stable order helps.
    const verdict = decideEdit({
      ...baseInput,
      canWrite: false,
      baseIsCurrent: false,
    });
    expect(verdict.kind).toBe("readonly");
  });

  it("returns no-op verdict when content equals currentContent (prevents frozen editor)", () => {
    // Frozen-editor prevention: VS Code does NOT fire
    // onDidChangeTextDocument for a WorkspaceEdit.replace whose
    // replacement text equals the existing range text. If the panel
    // ran applyEdit on identical bytes, the promise would resolve ok=
    // true but lastAppliedDocVersion would never advance and
    // postDocument would never fire — webview pinned with
    // editInFlight=true forever. The no-op verdict tells the panel to
    // re-post the current Document (same docVersion) to clear
    // editInFlight via the Task 8 pinned reducer behaviour, without
    // ever calling applyEdit.
    const verdict = decideEdit({
      ...baseInput,
      content: "# hello\n",
      currentContent: "# hello\n",
    });
    expect(verdict.kind).toBe("no-op");
  });

  it("treats an EOL-only difference as no-op, without writing it", () => {
    // An Edit built before an EOL-mode switch carries the old line endings;
    // `currentContent` is canonicalised to the new ones. Same text → no-op, so
    // no write is needed.
    const verdict = decideEdit({
      ...baseInput,
      content: "a\nb",
      currentContent: "a\r\nb",
    });
    expect(verdict.kind).toBe("no-op");
  });
});

describe("decideEdit — Markdown is stored as text", () => {
  it.each([
    "[x](javascript:alert(1))",
    "![x](data:image/svg+xml,test)",
    "[x](file:///tmp/example.md)",
    "[x](//example.com/path)",
    "---\ntitle: unfinished",
    "---\ntitle: x\u2028---\n---\nbody\n",
    "---\ntitle: x\r---\n---\nbody\n",
  ])("accepts %j", (content) => {
    expect(
      decideEdit({ baseIsCurrent: true, canWrite: true, content, currentContent: "seed" })
    ).toEqual({ kind: "accept" });
  });
});
