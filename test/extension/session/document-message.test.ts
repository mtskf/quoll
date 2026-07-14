import { describe, expect, it } from "vitest";

import {
  buildDocumentMessage,
  buildEditorConfigMessage,
  buildEditRejectedMessage,
  buildThemeMessage,
} from "../../../src/extension/session/document-message.js";
import { PROTOCOL_VERSION } from "../../../src/shared/protocol.js";

describe("buildDocumentMessage", () => {
  it("constructs the final-shape Document with no reason field", () => {
    const msg = buildDocumentMessage({
      content: "hello",
      docVersion: 7,
      themeKind: "dark",
      canWrite: false,
    });
    expect(msg).toEqual({
      protocol: PROTOCOL_VERSION,
      type: "document",
      content: "hello",
      docVersion: 7,
      themeKind: "dark",
      canWrite: false,
    });
  });

  it("carries an HC kind verbatim (host distinguishes HC from Light)", () => {
    expect(
      buildDocumentMessage({ content: "", docVersion: 0, themeKind: "hc-dark", canWrite: true })
        .themeKind
    ).toBe("hc-dark");
    expect(
      buildDocumentMessage({ content: "", docVersion: 0, themeKind: "hc-light", canWrite: true })
        .themeKind
    ).toBe("hc-light");
  });

  it("pins the emitted key set (so re-introducing reason on the emitter side fails CI)", () => {
    const msg = buildDocumentMessage({
      content: "",
      docVersion: 0,
      themeKind: "light",
      canWrite: true,
    });
    expect(Object.keys(msg).sort()).toEqual([
      "canWrite",
      "content",
      "docVersion",
      "protocol",
      "themeKind",
      "type",
    ]);
  });

  it("preserves canWrite=false for readonly documents", () => {
    const msg = buildDocumentMessage({
      content: "",
      docVersion: 0,
      themeKind: "light",
      canWrite: false,
    });
    expect(msg.canWrite).toBe(false);
  });
});

describe("buildThemeMessage", () => {
  it("constructs a dark Theme message at the current protocol version", () => {
    const msg = buildThemeMessage("dark");
    expect(msg).toEqual({
      protocol: PROTOCOL_VERSION,
      type: "theme",
      themeKind: "dark",
    });
  });

  it("constructs a light Theme message", () => {
    expect(buildThemeMessage("light").themeKind).toBe("light");
  });

  it("carries both HC kinds distinctly", () => {
    expect(buildThemeMessage("hc-dark").themeKind).toBe("hc-dark");
    expect(buildThemeMessage("hc-light").themeKind).toBe("hc-light");
  });

  it("includes protocol on the emitted key set", () => {
    expect(Object.keys(buildThemeMessage("dark")).sort()).toEqual([
      "protocol",
      "themeKind",
      "type",
    ]);
  });
});

describe("buildEditorConfigMessage", () => {
  const prefs = {
    fontFamily: "serif" as const,
    fontSize: "large" as const,
    lineHeight: "compact" as const,
    contentWidth: "wide" as const,
  };

  it("builds an editor-config message with the given flags and presets", () => {
    expect(buildEditorConfigMessage(true, true, true, prefs)).toEqual({
      protocol: PROTOCOL_VERSION,
      type: "editor-config",
      lintGutter: true,
      proseLint: true,
      spellcheck: true,
      fontFamily: "serif",
      fontSize: "large",
      lineHeight: "compact",
      contentWidth: "wide",
    });
  });

  it("carries the boolean flags through independently of the presets", () => {
    // Distinct values per flag so an argument-order swap is caught.
    const msg = buildEditorConfigMessage(true, false, true, prefs);
    expect(msg.lintGutter).toBe(true);
    expect(msg.proseLint).toBe(false);
    expect(msg.spellcheck).toBe(true);
  });

  it("emits exactly the editor-config key set (no extra fields on the wire)", () => {
    expect(Object.keys(buildEditorConfigMessage(false, false, false, prefs)).sort()).toEqual(
      [
        "contentWidth",
        "fontFamily",
        "fontSize",
        "lineHeight",
        "lintGutter",
        "proseLint",
        "protocol",
        "spellcheck",
        "type",
      ].sort()
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
