import { describe, expect, it } from "vitest";

import {
  buildDocumentMessage,
  buildEditorConfigMessage,
  buildEditRejectedMessage,
  buildThemeMessage,
} from "../../src/extension/document-message.js";
import { PROTOCOL_VERSION } from "../../src/shared/protocol.js";

describe("buildDocumentMessage", () => {
  it("constructs the final-shape Document with no reason field", () => {
    const msg = buildDocumentMessage({
      content: "hello",
      docVersion: 7,
      isDarkTheme: true,
      canWrite: false,
    });
    expect(msg).toEqual({
      protocol: PROTOCOL_VERSION,
      type: "document",
      content: "hello",
      docVersion: 7,
      isDarkTheme: true,
      canWrite: false,
    });
  });

  it("pins the emitted key set (so re-introducing reason on the emitter side fails CI)", () => {
    const msg = buildDocumentMessage({
      content: "",
      docVersion: 0,
      isDarkTheme: false,
      canWrite: true,
    });
    expect(Object.keys(msg).sort()).toEqual([
      "canWrite",
      "content",
      "docVersion",
      "isDarkTheme",
      "protocol",
      "type",
    ]);
  });

  it("preserves canWrite=false for readonly documents", () => {
    const msg = buildDocumentMessage({
      content: "",
      docVersion: 0,
      isDarkTheme: false,
      canWrite: false,
    });
    expect(msg.canWrite).toBe(false);
  });
});

describe("buildThemeMessage", () => {
  it("constructs a dark Theme message at the current protocol version", () => {
    const msg = buildThemeMessage(true);
    expect(msg).toEqual({
      protocol: PROTOCOL_VERSION,
      type: "theme",
      isDarkTheme: true,
    });
  });

  it("constructs a light Theme message", () => {
    expect(buildThemeMessage(false).isDarkTheme).toBe(false);
  });

  it("includes protocol on the emitted key set", () => {
    expect(Object.keys(buildThemeMessage(true)).sort()).toEqual([
      "isDarkTheme",
      "protocol",
      "type",
    ]);
  });
});

describe("buildEditorConfigMessage", () => {
  it("builds an editor-config message with the given flag", () => {
    expect(buildEditorConfigMessage(true)).toEqual({
      protocol: PROTOCOL_VERSION,
      type: "editor-config",
      lintGutter: true,
    });
    expect(buildEditorConfigMessage(false).lintGutter).toBe(false);
  });

  it("emits exactly the editor-config key set (no extra fields on the wire)", () => {
    expect(Object.keys(buildEditorConfigMessage(false)).sort()).toEqual(
      ["lintGutter", "protocol", "type"].sort()
    );
  });
});

describe("buildEditRejectedMessage", () => {
  it("constructs the final-shape message from a MarkdownError", () => {
    const msg = buildEditRejectedMessage({
      code: "unsafe_url",
      message: "URL is not in the allowlist: javascript:alert(1)",
    });
    expect(msg).toEqual({
      protocol: PROTOCOL_VERSION,
      type: "edit-rejected",
      error: {
        code: "unsafe_url",
        message: "URL is not in the allowlist: javascript:alert(1)",
      },
    });
  });

  it("preserves invalid_frontmatter code", () => {
    const msg = buildEditRejectedMessage({
      code: "invalid_frontmatter",
      message: "Frontmatter body contains a bare `---` line",
    });
    expect(msg.error.code).toBe("invalid_frontmatter");
  });

  it("strips detail from the wire shape", () => {
    // detail is intentionally NOT on the wire — keeps the protocol surface
    // small. Forward-compat additions are cheap because of the validator's
    // structural pass-through (test/shared/protocol.test.ts pin).
    const msg = buildEditRejectedMessage({
      code: "unsafe_url",
      message: "URL is not in the allowlist: javascript:alert(1)",
      detail: { url: "javascript:alert(1)" },
    });
    expect(Object.keys(msg.error).sort()).toEqual(["code", "message"]);
  });

  it("pins the emitted top-level key set", () => {
    const msg = buildEditRejectedMessage({ code: "unsafe_url", message: "x" });
    expect(Object.keys(msg).sort()).toEqual(["error", "protocol", "type"]);
  });
});
