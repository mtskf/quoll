// THE single configured GFM Markdown parser for host + webview markdown logic.
// One export so the extension set (GFM, Subscript, Superscript, Emoji,
// highlightMark) can never drift between consumers (URL walker, format
// classifier, structure oracle). The webview markdown LANGUAGE is still built
// separately from lang-markdown (markdown.ts) for editor concerns; this is the
// pure parse-only path. Parser is stateless across .parse() calls.
import { Emoji, GFM, parser, Subscript, Superscript } from "@lezer/markdown";
import { highlightMarkExtension } from "./highlight-mark.js";

export const gfmParser = parser.configure([
  GFM,
  Subscript,
  Superscript,
  Emoji,
  highlightMarkExtension,
]);
