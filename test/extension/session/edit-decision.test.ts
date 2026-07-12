import { describe, expect, it } from "vitest";

import { decideEdit } from "../../../src/extension/session/edit-decision.js";

describe("decideEdit", () => {
  // The adapter never holds a Schema — the validator is injected. The
  // default in production is validateMarkdownForWrite; tests inject fakes
  // so a parse-failed arm can be exercised deterministically.
  const okValidator = () => ({ ok: true }) as const;
  const failValidator = () =>
    ({
      ok: false,
      error: { code: "unsafe_url", message: "javascript: URL rejected" },
    }) as const;

  const baseInput = {
    baseDocVersion: 5,
    lastAppliedDocVersion: 5,
    canWrite: true,
    content: "# hello\n",
    currentContent: "different\n",
    markdownValidator: okValidator,
  };

  it("accepts a valid edit when base matches, canWrite=true, and content parses", () => {
    expect(decideEdit(baseInput).kind).toBe("accept");
  });

  it("rejects with kind=stale when baseDocVersion < lastAppliedDocVersion", () => {
    // The webview was editing on top of an older version than the host now
    // holds — the host must NOT applyEdit; it resyncs by posting the
    // current authoritative Document on the call site.
    expect(decideEdit({ ...baseInput, baseDocVersion: 4 }).kind).toBe("stale");
  });

  it("rejects with kind=stale when baseDocVersion > lastAppliedDocVersion", () => {
    // Impossible from a correct webview (the webview never mints version
    // numbers), but the host treats unexpected-newer the same as
    // unexpected-older — both fail strict equality, both resync.
    expect(decideEdit({ ...baseInput, baseDocVersion: 6 }).kind).toBe("stale");
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
      baseDocVersion: 4,
      lastAppliedDocVersion: 5,
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

  it("rejects with kind=parse-failed and surfaces the error when the validator fails", () => {
    // Defense in depth (plan §456-458): if the inbound content does not
    // parse, the host must NOT applyEdit. The webview gate should have
    // caught this; reaching the host is a sign the gate was bypassed or
    // a malformed payload slipped through.
    const verdict = decideEdit({ ...baseInput, markdownValidator: failValidator });
    expect(verdict.kind).toBe("parse-failed");
    if (verdict.kind === "parse-failed") {
      expect(verdict.error.code).toBe("unsafe_url");
    }
  });
});
