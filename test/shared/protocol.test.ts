import { describe, expect, it } from "vitest";

import {
  buildFormatCommandMessage,
  buildSwitchToTextMessage,
  isHostToWebview,
  isWebviewToHost,
  MAX_CONTENT_LENGTH,
  MAX_HREF_LENGTH,
  MAX_IMAGE_DATA_LENGTH,
  MAX_LINE_NUMBER,
  MAX_LINT_CODE_LENGTH,
  MAX_LINT_COORDINATE,
  MAX_LINT_DIAGNOSTICS,
  MAX_LINT_MESSAGE_LENGTH,
  PROTOCOL_VERSION,
} from "../../src/shared/protocol.js";

// These tests are the security boundary for every payload crossing the
// extension-host ⇄ webview seam. Any future protocol edit must keep them
// green — that is the contract.

// ---------- helpers ----------

const validDocument = () =>
  ({
    protocol: PROTOCOL_VERSION,
    type: "document",
    content: "hello",
    docVersion: 0,
    isDarkTheme: false,
    canWrite: true,
  }) as const;

const validTheme = () =>
  ({
    protocol: PROTOCOL_VERSION,
    type: "theme",
    isDarkTheme: true,
  }) as const;

const validReady = () =>
  ({
    protocol: PROTOCOL_VERSION,
    type: "ready",
  }) as const;

const validEdit = () =>
  ({
    protocol: PROTOCOL_VERSION,
    type: "edit",
    content: "edited",
    baseDocVersion: 1,
  }) as const;

// String of exactly `len` UTF-16 code units (matches the validator's
// String.prototype.length semantics).
const stringOfLength = (len: number): string => "a".repeat(len);

// ---------- envelope-level rejections (shared by both directions) ----------

describe("envelope rejections (both directions)", () => {
  // Labelled rather than raw — `it.each` with `%p` formatting cannot stringify
  // a Symbol, and the label is clearer in test output anyway.
  const nonObjects: Array<[string, unknown]> = [
    ["undefined", undefined],
    ["null", null],
    ["number 0", 0],
    ["number 1", 1],
    ["string", "document"],
    ["true", true],
    ["false", false],
    ["symbol", Symbol("x")],
    ["empty array", []],
    ["array of valid envelope", [{ protocol: 1, type: "document" }]],
  ];

  it.each(nonObjects)("isHostToWebview rejects %s", (_label, value) => {
    expect(isHostToWebview(value)).toBe(false);
  });

  it.each(nonObjects)("isWebviewToHost rejects %s", (_label, value) => {
    expect(isWebviewToHost(value)).toBe(false);
  });

  it("isHostToWebview rejects missing protocol field", () => {
    const { protocol: _omit, ...rest } = validDocument();
    expect(isHostToWebview(rest)).toBe(false);
  });

  it("isWebviewToHost rejects missing protocol field", () => {
    const { protocol: _omit, ...rest } = validEdit();
    expect(isWebviewToHost(rest)).toBe(false);
  });

  // Wrong protocol versions: anything other than the exact numeric constant
  // must be rejected. Strict equality means "1" (string) is not 1 (number).
  const wrongProtocols: Array<unknown> = [
    0,
    PROTOCOL_VERSION + 1,
    PROTOCOL_VERSION - 0.5,
    "1",
    null,
    undefined,
    true,
    {},
  ];

  it.each(wrongProtocols)("isHostToWebview rejects wrong protocol value %p", (protocol) => {
    expect(isHostToWebview({ ...validDocument(), protocol })).toBe(false);
    expect(isHostToWebview({ ...validTheme(), protocol })).toBe(false);
  });

  it.each(wrongProtocols)("isWebviewToHost rejects wrong protocol value %p", (protocol) => {
    expect(isWebviewToHost({ ...validEdit(), protocol })).toBe(false);
    expect(isWebviewToHost({ ...validReady(), protocol })).toBe(false);
  });

  it("isHostToWebview rejects missing type field", () => {
    expect(isHostToWebview({ protocol: PROTOCOL_VERSION })).toBe(false);
  });

  it("isWebviewToHost rejects missing type field", () => {
    expect(isWebviewToHost({ protocol: PROTOCOL_VERSION })).toBe(false);
  });

  const unknownTypes: Array<unknown> = [
    "init",
    "revive",
    "update",
    "Document",
    "DOCUMENT",
    "",
    null,
    undefined,
    0,
    1,
    {},
  ];

  it.each(unknownTypes)("isHostToWebview rejects unknown type %p", (type) => {
    expect(isHostToWebview({ protocol: PROTOCOL_VERSION, type })).toBe(false);
  });

  it.each(unknownTypes)("isWebviewToHost rejects unknown type %p", (type) => {
    expect(isWebviewToHost({ protocol: PROTOCOL_VERSION, type })).toBe(false);
  });
});

// ---------- isHostToWebview / document ----------

describe("isHostToWebview — document", () => {
  it("accepts a fully valid document", () => {
    expect(isHostToWebview(validDocument())).toBe(true);
  });

  it("accepts a fully valid document with no reason field", () => {
    expect(isHostToWebview(validDocument())).toBe(true);
  });

  it("validator is pass-through on reason: accepts documents that carry one", () => {
    // The validator never branches on `reason`; an inbound document with a
    // legacy reason payload is accepted unchanged (and the webview never
    // reads it). Pinning the new host emitter side is done in
    // test/extension/document-message.test.ts via Object.keys(...).sort().
    for (const reason of ["init", "revive", "external", "accepted", "anything"]) {
      expect(isHostToWebview({ ...validDocument(), reason })).toBe(true);
    }
  });

  it("validator is structurally pass-through on document: accepts arbitrary unknown extra fields", () => {
    // The validator is structural: extra unknown keys do not invalidate a
    // structurally correct envelope (additive forward-compat). A future
    // tightening is a deliberate decision, not a silent regression.
    expect(isHostToWebview({ ...validDocument(), metadata: { cursor: 42 } })).toBe(true);
    expect(
      isHostToWebview({ ...validDocument(), customField: "anything", anotherField: 123 })
    ).toBe(true);
  });

  it("rejects missing content", () => {
    const { content: _omit, ...rest } = validDocument();
    expect(isHostToWebview(rest)).toBe(false);
  });

  const nonStrings: Array<unknown> = [undefined, null, 0, 1, true, {}, [], Buffer.from("hi")];

  it.each(nonStrings)("rejects non-string content %p", (content) => {
    expect(isHostToWebview({ ...validDocument(), content })).toBe(false);
  });

  it("accepts empty string content", () => {
    expect(isHostToWebview({ ...validDocument(), content: "" })).toBe(true);
  });

  it("accepts content exactly at MAX_CONTENT_LENGTH", () => {
    const content = stringOfLength(MAX_CONTENT_LENGTH);
    expect(content.length).toBe(MAX_CONTENT_LENGTH);
    expect(isHostToWebview({ ...validDocument(), content })).toBe(true);
  });

  // Directional cap: MAX_CONTENT_LENGTH bounds webview→host edits only. The
  // host owns the canonical TextDocument and is not the abuse vector, so
  // host→webview Document.content is uncapped (any length is accepted, as
  // long as it is a string). Asserting the boundary explicitly here so that
  // a future regression (reintroducing a host-side cap) fails CI loudly.
  it("accepts content at MAX_CONTENT_LENGTH + 1 (host→webview is uncapped)", () => {
    const content = stringOfLength(MAX_CONTENT_LENGTH + 1);
    expect(content.length).toBe(MAX_CONTENT_LENGTH + 1);
    expect(isHostToWebview({ ...validDocument(), content })).toBe(true);
  });

  it("accepts content well beyond MAX_CONTENT_LENGTH (host→webview is uncapped)", () => {
    const content = stringOfLength(MAX_CONTENT_LENGTH * 2);
    expect(isHostToWebview({ ...validDocument(), content })).toBe(true);
  });

  it("rejects missing docVersion", () => {
    const { docVersion: _omit, ...rest } = validDocument();
    expect(isHostToWebview(rest)).toBe(false);
  });

  it("accepts docVersion === 0", () => {
    expect(isHostToWebview({ ...validDocument(), docVersion: 0 })).toBe(true);
  });

  it("accepts docVersion at Number.MAX_SAFE_INTEGER", () => {
    expect(
      isHostToWebview({
        ...validDocument(),
        docVersion: Number.MAX_SAFE_INTEGER,
      })
    ).toBe(true);
  });

  const badDocVersions: Array<unknown> = [
    -1,
    -0.5,
    0.5,
    1.0001,
    Number.MAX_SAFE_INTEGER + 1,
    Number.MAX_SAFE_INTEGER + 2,
    Number.MAX_VALUE,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NaN,
    "0",
    "1",
    null,
    undefined,
    true,
    false,
    {},
  ];

  it.each(badDocVersions)("rejects invalid docVersion %p", (docVersion) => {
    expect(isHostToWebview({ ...validDocument(), docVersion })).toBe(false);
  });

  const nonBooleans: Array<unknown> = [undefined, null, 0, 1, "true", "false", "", {}, []];

  it.each(nonBooleans)("rejects non-boolean isDarkTheme %p", (isDarkTheme) => {
    expect(isHostToWebview({ ...validDocument(), isDarkTheme })).toBe(false);
  });

  it.each(nonBooleans)("rejects non-boolean canWrite %p", (canWrite) => {
    expect(isHostToWebview({ ...validDocument(), canWrite })).toBe(false);
  });

  it("rejects missing isDarkTheme", () => {
    const { isDarkTheme: _omit, ...rest } = validDocument();
    expect(isHostToWebview(rest)).toBe(false);
  });

  it("rejects missing canWrite", () => {
    const { canWrite: _omit, ...rest } = validDocument();
    expect(isHostToWebview(rest)).toBe(false);
  });
});

// ---------- isHostToWebview / theme ----------

describe("isHostToWebview — theme", () => {
  it("accepts a valid theme message", () => {
    expect(isHostToWebview(validTheme())).toBe(true);
  });

  it("accepts both boolean values", () => {
    expect(isHostToWebview({ ...validTheme(), isDarkTheme: true })).toBe(true);
    expect(isHostToWebview({ ...validTheme(), isDarkTheme: false })).toBe(true);
  });

  const nonBooleans: Array<unknown> = [undefined, null, 0, 1, "true", "false", "", {}, []];

  it.each(nonBooleans)("rejects non-boolean isDarkTheme %p", (isDarkTheme) => {
    expect(isHostToWebview({ ...validTheme(), isDarkTheme })).toBe(false);
  });

  it("rejects missing isDarkTheme", () => {
    expect(isHostToWebview({ protocol: PROTOCOL_VERSION, type: "theme" })).toBe(false);
  });

  it("validator is structurally pass-through on theme: accepts arbitrary unknown extra fields", () => {
    // Same structural pass-through invariant as the document arm: extra unknown
    // keys do not invalidate a structurally correct envelope.
    expect(isHostToWebview({ ...validTheme(), reason: "theme-change" })).toBe(true);
    expect(isHostToWebview({ ...validTheme(), metadata: { foo: "bar" } })).toBe(true);
  });
});

// ---------- isWebviewToHost / ready ----------

describe("isWebviewToHost — ready", () => {
  it("accepts a valid ready message", () => {
    expect(isWebviewToHost(validReady())).toBe(true);
  });

  it("ignores extra fields on ready", () => {
    // The validator is structural: extra unknown keys do not invalidate a
    // structurally correct envelope. This documents that intent so a future
    // tightening (e.g. strict shape) is a deliberate decision, not a silent
    // regression.
    expect(isWebviewToHost({ ...validReady(), unexpected: "x" })).toBe(true);
  });
});

// ---------- isWebviewToHost / edit ----------

describe("isWebviewToHost — edit", () => {
  it("accepts a fully valid edit", () => {
    expect(isWebviewToHost(validEdit())).toBe(true);
  });

  it("rejects missing content", () => {
    const { content: _omit, ...rest } = validEdit();
    expect(isWebviewToHost(rest)).toBe(false);
  });

  const nonStrings: Array<unknown> = [undefined, null, 0, 1, true, {}, []];

  it.each(nonStrings)("rejects non-string content %p", (content) => {
    expect(isWebviewToHost({ ...validEdit(), content })).toBe(false);
  });

  it("accepts empty string content", () => {
    expect(isWebviewToHost({ ...validEdit(), content: "" })).toBe(true);
  });

  it("accepts content exactly at MAX_CONTENT_LENGTH", () => {
    const content = stringOfLength(MAX_CONTENT_LENGTH);
    expect(content.length).toBe(MAX_CONTENT_LENGTH);
    expect(isWebviewToHost({ ...validEdit(), content })).toBe(true);
  });

  it("rejects content at MAX_CONTENT_LENGTH + 1", () => {
    const content = stringOfLength(MAX_CONTENT_LENGTH + 1);
    expect(content.length).toBe(MAX_CONTENT_LENGTH + 1);
    expect(isWebviewToHost({ ...validEdit(), content })).toBe(false);
  });

  it("rejects missing baseDocVersion", () => {
    const { baseDocVersion: _omit, ...rest } = validEdit();
    expect(isWebviewToHost(rest)).toBe(false);
  });

  it("accepts baseDocVersion === 0", () => {
    expect(isWebviewToHost({ ...validEdit(), baseDocVersion: 0 })).toBe(true);
  });

  it("accepts baseDocVersion at Number.MAX_SAFE_INTEGER", () => {
    expect(
      isWebviewToHost({
        ...validEdit(),
        baseDocVersion: Number.MAX_SAFE_INTEGER,
      })
    ).toBe(true);
  });

  const badBaseDocVersions: Array<unknown> = [
    -1,
    -0.5,
    0.5,
    1.0001,
    Number.MAX_SAFE_INTEGER + 1,
    Number.MAX_SAFE_INTEGER + 2,
    Number.MAX_VALUE,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NaN,
    "0",
    "1",
    null,
    undefined,
    true,
    false,
    {},
  ];

  it.each(badBaseDocVersions)("rejects invalid baseDocVersion %p", (baseDocVersion) => {
    expect(isWebviewToHost({ ...validEdit(), baseDocVersion })).toBe(false);
  });

  it("validator is structurally pass-through on edit: accepts arbitrary unknown extra fields", () => {
    // Same structural pass-through invariant as the host-→-webview arms:
    // extra unknown keys do not invalidate a structurally correct envelope.
    expect(isWebviewToHost({ ...validEdit(), userAgent: "Quoll/0.5" })).toBe(true);
  });
});

// ---------- isWebviewToHost / open-external ----------

const validOpenExternal = () =>
  ({
    protocol: PROTOCOL_VERSION,
    type: "open-external",
    href: "https://example.com",
  }) as const;

describe("isWebviewToHost — open-external", () => {
  it("accepts a well-formed open-external", () => {
    expect(isWebviewToHost(validOpenExternal())).toBe(true);
  });

  it("rejects when href is missing", () => {
    const { href: _omit, ...rest } = validOpenExternal();
    expect(isWebviewToHost(rest)).toBe(false);
  });

  it("rejects when href is not a string", () => {
    for (const bad of [null, undefined, 42, true, [], {}]) {
      expect(isWebviewToHost({ ...validOpenExternal(), href: bad })).toBe(false);
    }
  });

  it("accepts href exactly at MAX_HREF_LENGTH", () => {
    const href = stringOfLength(MAX_HREF_LENGTH);
    expect(href.length).toBe(MAX_HREF_LENGTH);
    expect(isWebviewToHost({ ...validOpenExternal(), href })).toBe(true);
  });

  it("rejects href at MAX_HREF_LENGTH + 1", () => {
    const href = stringOfLength(MAX_HREF_LENGTH + 1);
    expect(href.length).toBe(MAX_HREF_LENGTH + 1);
    expect(isWebviewToHost({ ...validOpenExternal(), href })).toBe(false);
  });

  it("accepts unsafe-scheme hrefs (URL allowlist is the host's responsibility, NOT the protocol's)", () => {
    // The protocol validator is a SHAPE check, not a security predicate.
    // The host handler (Task 2) re-applies isAllowedUrl before openExternal.
    // Pinning this here so a future contributor does not bake URL policy
    // into the protocol layer (which would shift the gate to an untrusted
    // boundary and complicate test layering).
    for (const href of ["javascript:alert(1)", "data:text/html,x", "//evil/x", "vbscript:m"]) {
      expect(isWebviewToHost({ ...validOpenExternal(), href })).toBe(true);
    }
  });
});

// ---------- isWebviewToHost / open-link ----------

describe("isWebviewToHost — open-link", () => {
  it("accepts a well-formed open-link message", () => {
    expect(
      isWebviewToHost({ protocol: PROTOCOL_VERSION, type: "open-link", href: "./other.md" })
    ).toBe(true);
  });

  it("rejects open-link with a non-string href", () => {
    expect(isWebviewToHost({ protocol: PROTOCOL_VERSION, type: "open-link", href: 42 })).toBe(
      false
    );
  });

  it("rejects open-link whose href exceeds MAX_HREF_LENGTH", () => {
    expect(
      isWebviewToHost({
        protocol: PROTOCOL_VERSION,
        type: "open-link",
        href: "a".repeat(MAX_HREF_LENGTH + 1),
      })
    ).toBe(false);
  });
});

// ---------- isHostToWebview / edit-rejected ----------

describe("isHostToWebview — edit-rejected", () => {
  const validEditRejected = () => ({
    protocol: PROTOCOL_VERSION,
    type: "edit-rejected" as const,
    error: { code: "unsafe_url", message: "URL is not in the allowlist: javascript:alert(1)" },
  });

  it("accepts a fully valid edit-rejected", () => {
    expect(isHostToWebview(validEditRejected())).toBe(true);
  });

  it("rejects missing error.code", () => {
    const m = validEditRejected();
    // @ts-expect-error - intentionally malformed
    delete m.error.code;
    expect(isHostToWebview(m)).toBe(false);
  });

  it("rejects missing error.message", () => {
    const m = validEditRejected();
    // @ts-expect-error - intentionally malformed
    delete m.error.message;
    expect(isHostToWebview(m)).toBe(false);
  });

  it("rejects non-string error.code", () => {
    expect(isHostToWebview({ ...validEditRejected(), error: { code: 1, message: "x" } })).toBe(
      false
    );
  });

  it("rejects missing error object", () => {
    const { error: _omit, ...rest } = validEditRejected();
    expect(isHostToWebview(rest)).toBe(false);
  });

  it("rejects null error", () => {
    expect(isHostToWebview({ ...validEditRejected(), error: null })).toBe(false);
  });

  it("rejects protocol mismatch", () => {
    expect(isHostToWebview({ ...validEditRejected(), protocol: 999 })).toBe(false);
  });

  it("validator is structurally pass-through on edit-rejected: accepts arbitrary unknown extra fields", () => {
    expect(isHostToWebview({ ...validEditRejected(), futureField: "ignored" })).toBe(true);
  });
});

// ---------- isWebviewToHost / context-handoff ----------

const validContextHandoff = () =>
  ({
    protocol: PROTOCOL_VERSION,
    type: "context-handoff",
    hasSelection: true,
    startLine: 3,
    endLine: 7,
  }) as const;

describe("isWebviewToHost: context-handoff", () => {
  it("accepts a valid multi-line handoff", () => {
    expect(isWebviewToHost(validContextHandoff())).toBe(true);
  });
  it("accepts a no-selection handoff (hasSelection false, lines still present)", () => {
    expect(isWebviewToHost({ ...validContextHandoff(), hasSelection: false })).toBe(true);
  });
  it("accepts a single-line handoff", () => {
    expect(isWebviewToHost({ ...validContextHandoff(), startLine: 4, endLine: 4 })).toBe(true);
  });
  it("rejects a non-boolean hasSelection", () => {
    expect(isWebviewToHost({ ...validContextHandoff(), hasSelection: 1 })).toBe(false);
  });
  it("rejects a zero / non-positive line number", () => {
    expect(isWebviewToHost({ ...validContextHandoff(), startLine: 0 })).toBe(false);
  });
  it("rejects a fractional line number", () => {
    expect(isWebviewToHost({ ...validContextHandoff(), endLine: 2.5 })).toBe(false);
  });
  it("rejects a line number above MAX_LINE_NUMBER", () => {
    expect(isWebviewToHost({ ...validContextHandoff(), endLine: MAX_LINE_NUMBER + 1 })).toBe(false);
  });
  it("rejects a missing line field", () => {
    const { startLine: _omit, ...rest } = validContextHandoff();
    expect(isWebviewToHost(rest)).toBe(false);
  });
});

// ---------- image-write protocol ----------

describe("image-write protocol", () => {
  const okData = "iVBORw0KGgo=";

  it("accepts a well-formed image-write (webview→host)", () => {
    expect(
      isWebviewToHost({
        protocol: PROTOCOL_VERSION,
        type: "image-write",
        requestId: "1",
        data: okData,
      })
    ).toBe(true);
  });

  it("rejects image-write with oversized data", () => {
    const tooBig = "a".repeat(MAX_IMAGE_DATA_LENGTH + 1);
    expect(
      isWebviewToHost({
        protocol: PROTOCOL_VERSION,
        type: "image-write",
        requestId: "1",
        data: tooBig,
      })
    ).toBe(false);
  });

  it("rejects image-write with a non-string requestId, oversized id, or missing data", () => {
    expect(
      isWebviewToHost({
        protocol: PROTOCOL_VERSION,
        type: "image-write",
        requestId: 1,
        data: okData,
      })
    ).toBe(false);
    expect(
      isWebviewToHost({
        protocol: PROTOCOL_VERSION,
        type: "image-write",
        requestId: "x".repeat(65),
        data: okData,
      })
    ).toBe(false);
    expect(
      isWebviewToHost({ protocol: PROTOCOL_VERSION, type: "image-write", requestId: "1" })
    ).toBe(false);
  });

  it("accepts a well-formed image-write-result (host→webview), ok and not-ok", () => {
    expect(
      isHostToWebview({
        protocol: PROTOCOL_VERSION,
        type: "image-write-result",
        requestId: "1",
        ok: true,
        relativePath: "./assets/abc.png",
      })
    ).toBe(true);
    expect(
      isHostToWebview({
        protocol: PROTOCOL_VERSION,
        type: "image-write-result",
        requestId: "1",
        ok: false,
      })
    ).toBe(true);
  });

  it("rejects image-write-result with a non-string relativePath", () => {
    expect(
      isHostToWebview({
        protocol: PROTOCOL_VERSION,
        type: "image-write-result",
        requestId: "1",
        ok: true,
        relativePath: 5,
      })
    ).toBe(false);
  });

  it("rejects an incoherent ok:true with a missing relativePath", () => {
    expect(
      isHostToWebview({
        protocol: PROTOCOL_VERSION,
        type: "image-write-result",
        requestId: "1",
        ok: true,
      })
    ).toBe(false);
  });

  it("rejects an incoherent ok:false that carries a relativePath", () => {
    expect(
      isHostToWebview({
        protocol: PROTOCOL_VERSION,
        type: "image-write-result",
        requestId: "1",
        ok: false,
        relativePath: "./assets/abc.png",
      })
    ).toBe(false);
  });
});

// ---------- isHostToWebview / editor-config ----------

describe("isHostToWebview — editor-config", () => {
  const valid = () => ({
    protocol: PROTOCOL_VERSION,
    type: "editor-config" as const,
    lintGutter: false,
    spellcheck: true,
    fontFamily: "default" as const,
    fontSize: "default" as const,
    lineHeight: "cozy" as const,
    contentWidth: "medium" as const,
  });

  it("accepts a well-formed editor-config", () => {
    expect(isHostToWebview(valid())).toBe(true);
    expect(isHostToWebview({ ...valid(), lintGutter: true })).toBe(true);
    expect(isHostToWebview({ ...valid(), spellcheck: false })).toBe(true);
  });

  it("rejects a non-boolean lintGutter", () => {
    expect(isHostToWebview({ ...valid(), lintGutter: "yes" })).toBe(false);
    expect(isHostToWebview({ ...valid(), lintGutter: 1 })).toBe(false);
  });

  it("rejects a missing lintGutter", () => {
    const { lintGutter: _omit, ...rest } = valid();
    expect(isHostToWebview(rest)).toBe(false);
  });

  it("rejects a non-boolean spellcheck", () => {
    expect(isHostToWebview({ ...valid(), spellcheck: "yes" })).toBe(false);
    expect(isHostToWebview({ ...valid(), spellcheck: 0 })).toBe(false);
  });

  it("rejects a missing spellcheck", () => {
    const { spellcheck: _omit, ...rest } = valid();
    expect(isHostToWebview(rest)).toBe(false);
  });

  it("rejects the wrong protocol version", () => {
    expect(isHostToWebview({ ...valid(), protocol: 2 })).toBe(false);
  });
});

// ---------- isHostToWebview / editor-config preset fields ----------
describe("isHostToWebview — editor-config preset fields", () => {
  const valid = () => ({
    protocol: PROTOCOL_VERSION,
    type: "editor-config" as const,
    lintGutter: false,
    spellcheck: true,
    fontFamily: "default" as const,
    fontSize: "default" as const,
    lineHeight: "cozy" as const,
    contentWidth: "medium" as const,
  });

  it("accepts a well-formed editor-config with preset fields", () => {
    expect(isHostToWebview(valid())).toBe(true);
    expect(isHostToWebview({ ...valid(), fontFamily: "serif" })).toBe(true);
    expect(isHostToWebview({ ...valid(), fontSize: "x-large" })).toBe(true);
    expect(isHostToWebview({ ...valid(), lineHeight: "roomy" })).toBe(true);
    expect(isHostToWebview({ ...valid(), contentWidth: "wide" })).toBe(true);
  });

  it("rejects an unknown preset id on any field", () => {
    expect(isHostToWebview({ ...valid(), fontFamily: "comic-sans" })).toBe(false);
    expect(isHostToWebview({ ...valid(), fontSize: "huge" })).toBe(false);
    expect(isHostToWebview({ ...valid(), lineHeight: "tight" })).toBe(false);
    expect(isHostToWebview({ ...valid(), contentWidth: "full" })).toBe(false);
  });

  it("rejects a missing preset field", () => {
    const { fontFamily: _omit, ...rest } = valid();
    expect(isHostToWebview(rest)).toBe(false);
  });
});

// ---------- isWebviewToHost / update-config ----------
describe("isWebviewToHost — update-config", () => {
  const valid = () => ({
    protocol: PROTOCOL_VERSION,
    type: "update-config" as const,
    key: "quoll.editor.fontFamily" as const,
    value: "serif" as const,
  });

  it("accepts a well-formed update-config for each key", () => {
    expect(isWebviewToHost(valid())).toBe(true);
    expect(isWebviewToHost({ ...valid(), key: "quoll.editor.fontSize", value: "large" })).toBe(true);
    expect(isWebviewToHost({ ...valid(), key: "quoll.editor.lineHeight", value: "compact" })).toBe(
      true
    );
    expect(isWebviewToHost({ ...valid(), key: "quoll.editor.contentWidth", value: "wide" })).toBe(
      true
    );
  });

  it("rejects an unknown key", () => {
    expect(isWebviewToHost({ ...valid(), key: "quoll.lint.gutter.enabled" })).toBe(false);
    expect(isWebviewToHost({ ...valid(), key: "arbitrary.key" })).toBe(false);
  });

  it("rejects a prototype key WITHOUT throwing (Object.hasOwn gate, not `in`)", () => {
    // `"toString" in EDITOR_PREF_VALUE_SETS` is TRUE on a plain object, which
    // would then index a Function and throw on `.has(...)`. isWebviewToHost is
    // called un-try/caught in the host handleInbound, so a throw here crashes
    // the host message handler. Object.hasOwn makes this a clean `false`.
    expect(() => isWebviewToHost({ ...valid(), key: "toString", value: "x" })).not.toThrow();
    expect(isWebviewToHost({ ...valid(), key: "toString", value: "x" })).toBe(false);
    expect(isWebviewToHost({ ...valid(), key: "constructor", value: "x" })).toBe(false);
  });

  it("rejects a value not in the key's enum (cross-key value rejected too)", () => {
    expect(isWebviewToHost({ ...valid(), value: "large" })).toBe(false); // large ∈ fontSize, not fontFamily
    expect(isWebviewToHost({ ...valid(), value: "nonsense" })).toBe(false);
    expect(
      isWebviewToHost({
        key: "quoll.editor.fontSize",
        value: "serif",
        protocol: PROTOCOL_VERSION,
        type: "update-config",
      })
    ).toBe(false);
  });

  it("rejects non-string key/value", () => {
    expect(isWebviewToHost({ ...valid(), key: 1 })).toBe(false);
    expect(isWebviewToHost({ ...valid(), value: 2 })).toBe(false);
  });
});

// ---------- isWebviewToHost / lint-diagnostics ----------

describe("isWebviewToHost — lint-diagnostics", () => {
  const wireDiag = (over: Record<string, unknown> = {}) => ({
    startLine: 2,
    startCharacter: 0,
    endLine: 2,
    endCharacter: 8,
    severity: "warning",
    code: "heading-increment",
    message: "Heading levels should increment by one.",
    ...over,
  });
  const msg = (diagnostics: unknown[]) => ({
    protocol: PROTOCOL_VERSION,
    type: "lint-diagnostics",
    diagnostics,
  });

  it("accepts a well-formed lint-diagnostics message", () => {
    expect(isWebviewToHost(msg([wireDiag()]))).toBe(true);
  });

  it("accepts an empty diagnostics array (the clear signal)", () => {
    expect(isWebviewToHost(msg([]))).toBe(true);
  });

  it("accepts severity info", () => {
    expect(isWebviewToHost(msg([wireDiag({ severity: "info" })]))).toBe(true);
  });

  it("rejects an unknown severity", () => {
    expect(isWebviewToHost(msg([wireDiag({ severity: "error" })]))).toBe(false);
  });

  it("rejects a non-integer coordinate", () => {
    expect(isWebviewToHost(msg([wireDiag({ startCharacter: 1.5 })]))).toBe(false);
  });

  it("rejects a negative coordinate", () => {
    expect(isWebviewToHost(msg([wireDiag({ startLine: -1 })]))).toBe(false);
  });

  it("rejects a coordinate above MAX_LINT_COORDINATE", () => {
    expect(
      isWebviewToHost(msg([wireDiag({ endLine: MAX_LINT_COORDINATE + 1, endCharacter: 0 })]))
    ).toBe(false);
  });

  it("rejects an inverted range (start after end)", () => {
    expect(isWebviewToHost(msg([wireDiag({ startLine: 5, endLine: 2 })]))).toBe(false);
    expect(
      isWebviewToHost(
        msg([wireDiag({ startLine: 2, startCharacter: 9, endLine: 2, endCharacter: 1 })])
      )
    ).toBe(false);
  });

  it("rejects a missing message field", () => {
    const d = wireDiag();
    delete (d as Record<string, unknown>).message;
    expect(isWebviewToHost(msg([d]))).toBe(false);
  });

  it("rejects an over-long message", () => {
    expect(
      isWebviewToHost(msg([wireDiag({ message: "x".repeat(MAX_LINT_MESSAGE_LENGTH + 1) })]))
    ).toBe(false);
  });

  it("rejects an over-long code", () => {
    expect(isWebviewToHost(msg([wireDiag({ code: "x".repeat(MAX_LINT_CODE_LENGTH + 1) })]))).toBe(
      false
    );
  });

  it("rejects an over-long diagnostics array", () => {
    const many = Array.from({ length: MAX_LINT_DIAGNOSTICS + 1 }, () => wireDiag());
    expect(isWebviewToHost(msg(many))).toBe(false);
  });

  it("rejects a non-array diagnostics field", () => {
    expect(isWebviewToHost({ ...msg([]), diagnostics: "nope" })).toBe(false);
  });

  it("rejects a sparse diagnostics array (holes must not bypass .every)", () => {
    const sparse: unknown[] = [wireDiag()];
    sparse.length = 3; // [wireDiag, <hole>, <hole>]
    expect(isWebviewToHost(msg(sparse))).toBe(false);
  });
});

// ---------- caret handoff (caret-report / caret-apply) ----------

const validCaretReport = () =>
  ({
    protocol: PROTOCOL_VERSION,
    type: "caret-report",
    line: 0,
    character: 0,
    selectedChars: 0,
  }) as const;

const validCaretApply = () =>
  ({
    protocol: PROTOCOL_VERSION,
    type: "caret-apply",
    line: 3,
    character: 7,
  }) as const;

describe("caret-report (webview→host)", () => {
  it("accepts a valid 0-based caret-report", () => {
    expect(isWebviewToHost(validCaretReport())).toBe(true);
  });

  it("accepts caret at the MAX_LINT_COORDINATE cap", () => {
    expect(
      isWebviewToHost({
        ...validCaretReport(),
        line: MAX_LINT_COORDINATE,
        character: MAX_LINT_COORDINATE,
      })
    ).toBe(true);
  });

  it("accepts a non-empty selectedChars up to the coordinate cap", () => {
    expect(isWebviewToHost({ ...validCaretReport(), selectedChars: 147 })).toBe(true);
    expect(isWebviewToHost({ ...validCaretReport(), selectedChars: MAX_LINT_COORDINATE })).toBe(
      true
    );
  });

  it.each([
    ["negative line", { line: -1, character: 0 }],
    ["negative character", { line: 0, character: -1 }],
    ["fractional line", { line: 1.5, character: 0 }],
    ["over-cap line", { line: MAX_LINT_COORDINATE + 1, character: 0 }],
    ["NaN character", { line: 0, character: Number.NaN }],
    ["string line", { line: "0", character: 0 }],
    ["negative selectedChars", { selectedChars: -1 }],
    ["fractional selectedChars", { selectedChars: 2.5 }],
    ["over-cap selectedChars", { selectedChars: MAX_LINT_COORDINATE + 1 }],
    ["NaN selectedChars", { selectedChars: Number.NaN }],
    ["string selectedChars", { selectedChars: "0" }],
  ])("rejects %s", (_label, patch) => {
    expect(isWebviewToHost({ ...validCaretReport(), ...patch })).toBe(false);
  });

  it("rejects a caret-report missing selectedChars", () => {
    const { selectedChars: _omit, ...withoutCount } = validCaretReport();
    expect(isWebviewToHost(withoutCount)).toBe(false);
  });

  it("is not accepted by the host→webview validator", () => {
    expect(isHostToWebview(validCaretReport())).toBe(false);
  });
});

describe("caret-apply (host→webview)", () => {
  it("accepts a valid 0-based caret-apply", () => {
    expect(isHostToWebview(validCaretApply())).toBe(true);
  });

  it("accepts caret at the MAX_LINT_COORDINATE cap", () => {
    expect(
      isHostToWebview({
        ...validCaretApply(),
        line: MAX_LINT_COORDINATE,
        character: MAX_LINT_COORDINATE,
      })
    ).toBe(true);
  });

  it.each([
    ["negative character", { line: 0, character: -1 }],
    ["fractional character", { line: 0, character: 2.2 }],
    ["over-cap character", { line: 0, character: MAX_LINT_COORDINATE + 1 }],
    ["missing character", { line: 0 }],
    ["string character", { line: 0, character: "7" }],
  ])("rejects %s", (_label, patch) => {
    // delete-to-missing for the "missing character" case
    const base = { ...validCaretApply(), ...patch } as Record<string, unknown>;
    if (!("character" in patch)) {
      delete base.character;
    }
    expect(isHostToWebview(base)).toBe(false);
  });

  it("is not accepted by the webview→host validator", () => {
    expect(isWebviewToHost(validCaretApply())).toBe(false);
  });
});

describe("isWebviewToHost: codex-context-handoff", () => {
  it("accepts a codex-context-handoff envelope (no payload fields)", () => {
    expect(isWebviewToHost({ protocol: PROTOCOL_VERSION, type: "codex-context-handoff" })).toBe(
      true
    );
  });
  it("rejects a mismatched protocol version", () => {
    expect(isWebviewToHost({ protocol: PROTOCOL_VERSION + 1, type: "codex-context-handoff" })).toBe(
      false
    );
  });
  it("still rejects an unknown message type", () => {
    expect(isWebviewToHost({ protocol: PROTOCOL_VERSION, type: "codex-nope" })).toBe(false);
  });
});

describe("isWebviewToHost: switch-to-text", () => {
  it("accepts a switch-to-text envelope (no payload fields)", () => {
    expect(isWebviewToHost({ protocol: PROTOCOL_VERSION, type: "switch-to-text" })).toBe(true);
  });
  it("rejects a wrong protocol version", () => {
    expect(isWebviewToHost({ protocol: PROTOCOL_VERSION + 1, type: "switch-to-text" })).toBe(false);
  });
  it("ignores unknown extra fields (forward-compat)", () => {
    expect(isWebviewToHost({ protocol: PROTOCOL_VERSION, type: "switch-to-text", x: 1 })).toBe(
      true
    );
  });
});

describe("buildSwitchToTextMessage", () => {
  it("produces the envelope-only shape", () => {
    expect(buildSwitchToTextMessage()).toEqual({
      protocol: PROTOCOL_VERSION,
      type: "switch-to-text",
    });
  });
  it("produces a message that passes isWebviewToHost", () => {
    expect(isWebviewToHost(buildSwitchToTextMessage())).toBe(true);
  });
});

describe("format-command message", () => {
  it("builds a valid envelope", () => {
    const m = buildFormatCommandMessage("bold");
    expect(m).toEqual({ protocol: PROTOCOL_VERSION, type: "format-command", action: "bold" });
    expect(isHostToWebview(m)).toBe(true);
  });

  it("accepts every action", () => {
    for (const a of ["bold", "italic", "code", "strike", "link"] as const) {
      expect(isHostToWebview(buildFormatCommandMessage(a))).toBe(true);
    }
  });

  it("rejects an unknown action", () => {
    expect(
      isHostToWebview({ protocol: PROTOCOL_VERSION, type: "format-command", action: "underline" })
    ).toBe(false);
  });

  it("rejects a missing action", () => {
    expect(isHostToWebview({ protocol: PROTOCOL_VERSION, type: "format-command" })).toBe(false);
  });
});
