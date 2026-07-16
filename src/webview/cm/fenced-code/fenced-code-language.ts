// Single source of the LANGUAGE-TOKEN geometry of a FencedCode open fence — the
// info string's leading plain-identifier word (CommonMark's "language" of a code
// block) and the exact document ranges the picker rewrites. Companion to
// fenced-code-body.ts (body landmarks): that owns "where the body is", this owns
// "where the language token is".
//
// Open fence line: `[indent][> ]```[info string]`. Lezer emits the ``` as the
// FencedCode's opening CodeMark and the info string (when present) as a CodeInfo
// child. Two edit ranges are exposed:
//   - tokenFrom..tokenTo — the leading language word (set/change rewrite target);
//     trailing info-string content (e.g. ```js title="x") is preserved.
//   - infoFrom..infoTo — the WHOLE info string (clear target), so clearing to a
//     bare fence leaves no residual attribute to be reparsed as a language.
// A NON-PLAIN info string (one that does not begin with a plain language
// identifier — e.g. a Pandoc/Kramdown attr-list ```{.js #id}) yields null: the
// picker is suppressed rather than risk corrupting brace/attr syntax. Absolute
// offsets throughout, so a top-level or blockquote-/list-nested fence rewrites
// identically.

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { asFencedCodeNode, type FencedCodeNode, type OpenLineOffset } from "./fenced-code-node.js";

// A "plain language identifier": the leading run of a simple fence language
// (letters/digits and the handful of punctuation real language tags use, e.g.
// c++, c#, objective-c, f#). Deliberately EXCLUDES '{' so a Pandoc/Kramdown
// attr-list info string does not match — those fences get no picker.
const PLAIN_LANGUAGE = /^[A-Za-z0-9_+#.-]+/;

export type FenceLanguageTarget = {
  /** Current language token — the info string's leading plain word; "" for a
   *  bare fence or empty info string. */
  language: string;
  /** Range to replace on set/change (the language word). For a bare fence this
   *  is the empty insertion point just after the open ``` (tokenFrom === tokenTo
   *  === open CodeMark.to). */
  tokenFrom: number;
  tokenTo: number;
  /** Range to replace on clear (the WHOLE info string). Equals tokenFrom/tokenTo
   *  when there is no info string. */
  infoFrom: number;
  infoTo: number;
};

/** Language-token target of a FencedCode `node`, or null when it has no opening
 *  CodeMark (malformed) OR its info string is non-plain (attr-list etc. — the
 *  picker is suppressed to avoid corrupting non-language info). One direct-
 *  children pass: the FIRST CodeMark is the opening fence (a closed block also
 *  has a closing CodeMark — ignored); a CodeInfo child, when present, holds the
 *  info string. */
export function fenceLanguageTarget(
  state: EditorState,
  node: FencedCodeNode
): FenceLanguageTarget | null {
  let openMarkTo: number | null = null;
  let infoFrom: number | null = null;
  let infoTo: number | null = null;
  const cursor = node.cursor();
  if (cursor.firstChild()) {
    do {
      if (cursor.name === "CodeMark") {
        if (openMarkTo === null) {
          openMarkTo = cursor.to;
        }
      } else if (cursor.name === "CodeInfo") {
        infoFrom = cursor.from;
        infoTo = cursor.to;
      }
    } while (cursor.nextSibling());
  }
  if (openMarkTo === null) {
    return null;
  }
  if (infoFrom === null || infoTo === null) {
    // Bare fence: empty token, insertion point just after the open ```.
    return {
      language: "",
      tokenFrom: openMarkTo,
      tokenTo: openMarkTo,
      infoFrom: openMarkTo,
      infoTo: openMarkTo,
    };
  }
  const info = state.sliceDoc(infoFrom, infoTo);
  const match = PLAIN_LANGUAGE.exec(info);
  if (match === null) {
    // Non-plain info (e.g. `{.js #id}`) — suppress the picker.
    return null;
  }
  const token = match[0];
  return {
    language: token,
    tokenFrom: infoFrom,
    tokenTo: infoFrom + token.length,
    infoFrom,
    infoTo,
  };
}

/** Language-token target of the fenced block whose OPEN line begins at
 *  `openFrom`, or null when no such (plain) block exists there. The LAZY,
 *  dispatch-time resolver: the widget stores `openFrom` (its eq key, always the
 *  live offset) and the command calls this against the LIVE state, so the edit
 *  targets the CURRENT block. Scopes the walk to the open line, matching the
 *  builder's anchor rule (doc.lineAt(node.from).from). Mirrors fencedCodeBodyAt. */
export function fenceLanguageTargetAt(
  state: EditorState,
  openFrom: OpenLineOffset
): FenceLanguageTarget | null {
  const doc = state.doc;
  if (openFrom < 0 || openFrom > doc.length) {
    return null;
  }
  const openLine = doc.lineAt(openFrom);
  let target: FenceLanguageTarget | null = null;
  syntaxTree(state).iterate({
    from: openLine.from,
    to: openLine.to,
    enter: (node) => {
      if (target !== null) {
        return false;
      }
      const fenced = asFencedCodeNode(node);
      if (fenced !== null && doc.lineAt(fenced.from).from === openLine.from) {
        target = fenceLanguageTarget(state, fenced);
        return false;
      }
      return undefined;
    },
  });
  return target;
}

/** The document change that rewrites `target` to language `chosen`, or null when
 *  `chosen` already equals the current language (no-op — avoids a redundant
 *  dispatch/history entry). `chosen === ""` CLEARS: it replaces the WHOLE info
 *  string so no trailing attribute survives to be reparsed as a language. A
 *  non-empty `chosen` rewrites only the language WORD (tokenFrom..tokenTo),
 *  preserving trailing info-string content. Shared by the command and the
 *  round-trip tests so "what edit the picker makes" has ONE definition. */
export function languageChangeSpec(
  target: FenceLanguageTarget,
  chosen: string
): { from: number; to: number; insert: string } | null {
  if (target.language === chosen) {
    return null;
  }
  if (chosen === "") {
    return { from: target.infoFrom, to: target.infoTo, insert: "" };
  }
  return { from: target.tokenFrom, to: target.tokenTo, insert: chosen };
}
