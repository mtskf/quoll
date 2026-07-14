// Maps a fenced-code info string to a nested CodeMirror parser for DISPLAY-ONLY
// syntax highlighting, and exposes the nested languages as highlight scopes. Consumed
// by markdown.ts's parseCode() wrap (codeParserFor) and by the language-scoped code
// HighlightStyle (CODE_LANGUAGES). Keys mirror fenced-code-languages.ts's picker
// `value`s plus common aliases, so a language chosen in the picker highlights (pinned
// by a contract test). Unmapped info strings return null -> the fence renders as plain
// monospace (the accepted no-highlight baseline). No htmlParser is wired in markdown.ts
// -- RAW HTML in the Markdown body stays opaque -- but a fenced ```html block IS
// highlighted here via the legacy xml/html stream mode (codeParser, not htmlParser).
//
// Each mode is imported from its own @codemirror/legacy-modes/mode/<file> so esbuild
// tree-shakes to only the modes used. Each StreamLanguage is built ONCE (canonical
// const); aliases reference the same instance.

import {
  HighlightStyle,
  StreamLanguage,
  type StreamParser,
  syntaxHighlighting,
} from "@codemirror/language";
import { c, cpp, csharp, java } from "@codemirror/legacy-modes/mode/clike";
import { css } from "@codemirror/legacy-modes/mode/css";
import { go } from "@codemirror/legacy-modes/mode/go";
import { javascript, json, typescript } from "@codemirror/legacy-modes/mode/javascript";
import { python } from "@codemirror/legacy-modes/mode/python";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { rust } from "@codemirror/legacy-modes/mode/rust";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { standardSQL } from "@codemirror/legacy-modes/mode/sql";
import { html, xml } from "@codemirror/legacy-modes/mode/xml";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import type { Extension } from "@codemirror/state";
import { type Parser, parseMixed } from "@lezer/common";
import type { MarkdownExtension } from "@lezer/markdown";
import { quollCodeHighlightSpec } from "../theme.js";

const lang = (mode: StreamParser<unknown>): StreamLanguage<unknown> => StreamLanguage.define(mode);

// Canonical per-mode StreamLanguage instances (one each).
const JS = lang(javascript);
const TS = lang(typescript);
const JSON_ = lang(json);
const HTML = lang(html);
const XML = lang(xml);
const CSS = lang(css);
const PY = lang(python);
const JAVA = lang(java);
const C = lang(c);
const CPP = lang(cpp);
const CSHARP = lang(csharp);
const GO = lang(go);
const RUST = lang(rust);
const RUBY = lang(ruby);
const SHELL = lang(shell);
const SQL = lang(standardSQL);
const YAML = lang(yaml);

// The distinct nested languages -- used as highlight scopes (see the scoped
// HighlightStyle at the bottom of this module).
export const CODE_LANGUAGES: readonly StreamLanguage<unknown>[] = [
  JS,
  TS,
  JSON_,
  HTML,
  XML,
  CSS,
  PY,
  JAVA,
  C,
  CPP,
  CSHARP,
  GO,
  RUST,
  RUBY,
  SHELL,
  SQL,
  YAML,
];

// info-string id -> parser. A Map (NOT an object literal) so an untrusted id like
// `constructor` / `__proto__` resolves to undefined, not an inherited Object.prototype
// member (which CM would try to use as a parser and throw on). jsx/tsx reuse js/ts.
const PARSERS: Map<string, Parser> = new Map([
  ["js", JS.parser],
  ["javascript", JS.parser],
  ["jsx", JS.parser],
  ["ts", TS.parser],
  ["typescript", TS.parser],
  ["tsx", TS.parser],
  ["json", JSON_.parser],
  ["html", HTML.parser],
  ["xml", XML.parser],
  ["css", CSS.parser],
  ["python", PY.parser],
  ["py", PY.parser],
  ["java", JAVA.parser],
  ["c", C.parser],
  ["cpp", CPP.parser],
  ["c++", CPP.parser],
  ["csharp", CSHARP.parser],
  ["cs", CSHARP.parser],
  ["go", GO.parser],
  ["rust", RUST.parser],
  ["rs", RUST.parser],
  ["ruby", RUBY.parser],
  ["rb", RUBY.parser],
  ["shell", SHELL.parser],
  ["sh", SHELL.parser],
  ["bash", SHELL.parser],
  ["sql", SQL.parser],
  ["yaml", YAML.parser],
  ["yml", YAML.parser],
]);

// Picker `value`s that DELIBERATELY have no highlighter -- pinned by the picker<->map
// sync test so the two registries can't silently drift. `php` is excluded (its legacy
// mode multiplexes with htmlmixed -- extra weight + reintroduces HTML highlighting
// against the no-lang-html spirit); `markdown` is excluded (nesting Markdown in itself
// is recursive with little payoff). Both render as plain monospace.
export const HIGHLIGHT_UNSUPPORTED: ReadonlySet<string> = new Set(["php", "markdown"]);

// The nested parser for a fenced-code info string, or null when unmapped. Only the
// first whitespace-delimited token is the language id -- `parseCode` passes the RAW
// CodeInfo text (verified against @lezer/markdown; it does NOT pre-strip), so the
// leading-\S* extraction below mirrors @codemirror/lang-markdown's own getCodeParser.
export function codeParserFor(info: string): Parser | null {
  const id = /\S*/.exec(info)?.[0]?.toLowerCase() ?? "";
  return (id ? PARSERS.get(id) : undefined) ?? null;
}

// Skip nested highlighting for very large code blocks. The mixed parser is
// ~10-25x slower than plain Markdown, and Quoll's synchronous full-document
// ensureSyntaxTree(..., 50ms) hot paths (list-continuation-keymap, list-transform,
// outline-panel) fail closed when EOF isn't reached within budget. Enabling nested
// parsing unconditionally would let one enormous mapped fence (e.g. a pasted source
// or log file) tip those into their degraded fallback earlier than a plain-Markdown
// doc of the same size would. A block this large is far beyond any real snippet, so
// rendering it as plain monospace (the accepted no-highlight baseline) is the right
// trade — it keeps those budgets intact. Guard on the node's byte span; the dominant
// cost is a single huge block (measured in PR #214 review).
const NESTED_HIGHLIGHT_MAX_BYTES = 50_000;

// Nested-parse wrap for fenced/indented code. Reproduces @lezer/markdown's parseCode
// wrap (overlay on CodeText, bracketed for fenced blocks) PLUS the size guard above:
// parseCode's own codeParser callback only receives the info string, never the block
// size, so the guard has to live at the parseMixed level. Node names are the stable
// @lezer/markdown public names already relied on by nonFoldableBlocks (markdown.ts).
// No htmlParser branch — raw HTML in the Markdown body stays opaque (the no-lang-html
// policy); a fenced ```html block is still highlighted via codeParserFor.
export const codeHighlightExtension: MarkdownExtension = {
  wrap: parseMixed((node, input) => {
    const name = node.type.name;
    if (name !== "FencedCode" && name !== "CodeBlock") {
      return null;
    }
    if (node.to - node.from > NESTED_HIGHLIGHT_MAX_BYTES) {
      return null;
    }
    let info = "";
    if (name === "FencedCode") {
      const infoNode = node.node.getChild("CodeInfo");
      if (infoNode) {
        info = input.read(infoNode.from, infoNode.to);
      }
    }
    const parser = codeParserFor(info);
    return parser
      ? { parser, overlay: (n) => n.type.name === "CodeText", bracketed: name === "FencedCode" }
      : null;
  }),
};

// One language-SCOPED HighlightStyle per nested code language. CM evaluates a
// highlighter's `scope` on each (sub-)tree's TOP node (@lezer/highlight highlightTree,
// mounted-overlay branch); only nested-code top nodes carry a code language's
// languageDataProp, so a { scope: <codeLanguage> } style is inert on every outer-Markdown
// node (TaskMarker/LinkTitle/HTML comment/entity), regardless of @lezer/highlight tag
// ancestry. This is the documented, stable mixed-language mechanism (public {scope}
// option — NOT internal-field mutation). ~17 tiny StyleModules is negligible injected
// CSS. `codeHighlightStyles` is exported for the leak-guard test (it feeds highlightTree
// directly, exactly as the runtime treeHighlighter does).
export const codeHighlightStyles: readonly HighlightStyle[] = CODE_LANGUAGES.map((l) =>
  HighlightStyle.define(quollCodeHighlightSpec, { scope: l })
);

export const quollCodeHighlighting: readonly Extension[] = codeHighlightStyles.map((s) =>
  syntaxHighlighting(s)
);
