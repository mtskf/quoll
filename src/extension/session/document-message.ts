// Pure helpers for the panel's outbound surface.
//
// Why extracted from QuollEditorPanel:
//   - buildDocumentMessage: single construction point for the final-
//     shape Document. The test pins the key set with Object.keys so
//     any future re-introduction of `reason` on the emitter side fails
//     CI before it reaches the wire.
//   - buildThemeMessage: removes the protocol literal from the panel so
//     the panel never holds wire-format constants directly.
//   - buildEditRejectedMessage: constructs the edit rejection message
//     from a MarkdownError, stripping detail from the wire shape.

import type { MarkdownError } from "../../markdown/errors.js";
import {
  type CaretApplyMessage,
  type ContentWidthPref,
  type DocumentMessage,
  type EditorConfigMessage,
  type EditRejectedMessage,
  type FontFamilyPref,
  type FontSizePref,
  type ImageWriteResultMessage,
  type LineHeightPref,
  PROTOCOL_VERSION,
  type ThemeKind,
  type ThemeMessage,
} from "../../shared/protocol.js";

export type EditorPrefs = {
  fontFamily: FontFamilyPref;
  fontSize: FontSizePref;
  lineHeight: LineHeightPref;
  contentWidth: ContentWidthPref;
};

export type BuildDocumentMessageInput = {
  content: string;
  docVersion: number;
  themeKind: ThemeKind;
  canWrite: boolean;
};

/** Construct the final-shape Document message. No `reason` field — the
 *  property is deliberately absent so a future re-introduction shows up
 *  as a TS error at every call site rather than as a silently-accepted
 *  extra field, and the Object.keys assertion in the unit test catches
 *  it before it reaches the wire. */
export function buildDocumentMessage(input: BuildDocumentMessageInput): DocumentMessage {
  return {
    protocol: PROTOCOL_VERSION,
    type: "document",
    content: input.content,
    docVersion: input.docVersion,
    themeKind: input.themeKind,
    canWrite: input.canWrite,
  };
}

/** Construct a Theme message. Centralised so the panel does not hold the
 *  PROTOCOL_VERSION literal directly. */
export function buildThemeMessage(themeKind: ThemeKind): ThemeMessage {
  return {
    protocol: PROTOCOL_VERSION,
    type: "theme",
    themeKind,
  };
}

/** Build an image-write-result. `relativePath === null` ⇒ rejected/failed
 *  (ok:false, no path); a string ⇒ success carrying the document-relative
 *  markdown destination. */
export function buildImageWriteResultMessage(
  requestId: string,
  relativePath: string | null
): ImageWriteResultMessage {
  return relativePath === null
    ? { protocol: PROTOCOL_VERSION, type: "image-write-result", requestId, ok: false }
    : { protocol: PROTOCOL_VERSION, type: "image-write-result", requestId, ok: true, relativePath };
}

/** Construct an EditorConfig message carrying the current editor-surface
 *  preferences. Pushed at seed time and on workspace.onDidChangeConfiguration.
 *  Kept separate from DocumentMessage so a settings change does not force a
 *  full document reseed. */
export function buildEditorConfigMessage(
  lintGutter: boolean,
  proseLint: boolean,
  spellcheck: boolean,
  prefs: EditorPrefs
): EditorConfigMessage {
  return {
    protocol: PROTOCOL_VERSION,
    type: "editor-config",
    lintGutter,
    proseLint,
    spellcheck,
    fontFamily: prefs.fontFamily,
    fontSize: prefs.fontSize,
    lineHeight: prefs.lineHeight,
    contentWidth: prefs.contentWidth,
  };
}

/** Construct a CaretApply message carrying a 0-based caret. Pushed once on the
 *  panel's active edge so the caret the user left in the text editor lands in
 *  Quoll. Centralised here so the panel does not hold the PROTOCOL_VERSION
 *  literal directly (same posture as buildThemeMessage / buildEditorConfigMessage). */
export function buildCaretApplyMessage(caret: {
  line: number;
  character: number;
}): CaretApplyMessage {
  return {
    protocol: PROTOCOL_VERSION,
    type: "caret-apply",
    line: caret.line,
    character: caret.character,
  };
}

/** Construct an EditRejected message from the host's parse-failed verdict.
 *  Strips `MarkdownError.detail` from the wire shape on purpose — the
 *  wire surface stays minimal (`code` + `message` are all the banner
 *  needs), and a future extension is a backward-compatible field add. */
export function buildEditRejectedMessage(error: MarkdownError): EditRejectedMessage {
  return {
    protocol: PROTOCOL_VERSION,
    type: "edit-rejected",
    error: {
      code: error.code,
      message: error.message,
    },
  };
}
