// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { buildEditRejectedMessage } from "../../src/extension/document-message.js";
import type { MarkdownError } from "../../src/markdown/errors.js";

// IMPORTANT: this file pins the 4-arm SHAPE of `postEditRejected` via
// a thin re-implementation (`makeFakeHelper`), NOT the production helper
// directly. The production helper closes over
// `resolveCustomTextEditor`'s `webviewPanel`/`document`/`disposed`
// and isn't currently exported. The trade-off: if the production helper
// drifts from this shape (e.g. someone removes the disposed guard or
// changes the fallback target), the production-side bug ISN'T caught
// here — only by the Task 9 E2E. Keep this test as the first green
// confirmation that the 4-arm wiring is sound; rely on E2E to defend
// against production drift. A future refactor could export the helper
// as a pure factory taking (`send`, `postDocument`, `disposedRef`) to
// make this test direct.

function makeFakeHelper(
  send: (msg: unknown) => Thenable<boolean>,
  postDocumentSpy: () => void,
  disposedRef: { v: boolean }
) {
  return (error: MarkdownError): Promise<void> =>
    new Promise<void>((resolve) => {
      if (disposedRef.v) {
        resolve();
        return;
      }
      const msg = buildEditRejectedMessage(error);
      void send(msg).then(
        (ok) => {
          if (disposedRef.v) {
            resolve();
            return;
          }
          if (ok) {
            // record event would fire here
            resolve();
            return;
          }
          postDocumentSpy();
          resolve();
        },
        () => {
          if (disposedRef.v) {
            resolve();
            return;
          }
          postDocumentSpy();
          resolve();
        }
      );
    });
}

const err: MarkdownError = {
  code: "unsafe_url",
  message: "URL is not in the allowlist: javascript:alert(1)",
};

describe("postEditRejected (Codex N11 pin)", () => {
  it("ok=true: no fallback postDocument", async () => {
    const postDocumentSpy = vi.fn();
    const send = vi.fn(async () => true);
    const helper = makeFakeHelper(send, postDocumentSpy, { v: false });
    await helper(err);
    expect(send).toHaveBeenCalledOnce();
    expect(postDocumentSpy).not.toHaveBeenCalled();
  });

  it("ok=false: falls back to postDocument", async () => {
    const postDocumentSpy = vi.fn();
    const send = vi.fn(async () => false);
    const helper = makeFakeHelper(send, postDocumentSpy, { v: false });
    await helper(err);
    expect(postDocumentSpy).toHaveBeenCalledOnce();
  });

  it("reject: falls back to postDocument", async () => {
    const postDocumentSpy = vi.fn();
    const send = vi.fn(() => Promise.reject(new Error("transport detached")));
    const helper = makeFakeHelper(send, postDocumentSpy, { v: false });
    await helper(err);
    expect(postDocumentSpy).toHaveBeenCalledOnce();
  });

  it("disposed before callback: NO fallback postDocument", async () => {
    const postDocumentSpy = vi.fn();
    const disposedRef = { v: false };
    let resolveSend!: (ok: boolean) => void;
    const send = vi.fn(
      () =>
        new Promise<boolean>((res) => {
          resolveSend = res;
        })
    );
    const helper = makeFakeHelper(send, postDocumentSpy, disposedRef);
    const inFlight = helper(err);
    disposedRef.v = true;
    resolveSend(false);
    await inFlight;
    expect(postDocumentSpy).not.toHaveBeenCalled();
  });

  it("disposed before initial send: early return, no send call", async () => {
    const postDocumentSpy = vi.fn();
    const send = vi.fn(async () => true);
    const helper = makeFakeHelper(send, postDocumentSpy, { v: true });
    await helper(err);
    expect(send).not.toHaveBeenCalled();
    expect(postDocumentSpy).not.toHaveBeenCalled();
  });
});
