import { MAX_LIST_NUMBER } from "../list/list-transform.js";
import { HARD_BREAK } from "./inline-runs.js";

/** DOM-free block representation and serialization for rich HTML paste. */
export interface PreparedInline {
  readonly markdown: string;
  readonly rich: boolean;
}

export type BlockNode =
  | { readonly kind: "paragraph"; readonly inline: PreparedInline }
  | { readonly kind: "heading"; readonly level: number; readonly inline: PreparedInline }
  | { readonly kind: "code"; readonly body: string; readonly lang: string }
  | { readonly kind: "table"; readonly gfm: string; readonly content: "visible" | "empty" }
  | { readonly kind: "rule" }
  | {
      readonly kind: "quote";
      readonly children: readonly BlockNode[];
      readonly hasOwnText: boolean;
    }
  | {
      readonly kind: "list";
      readonly ordered: boolean;
      readonly start: number;
      readonly items: readonly (readonly BlockNode[])[];
      readonly hasOwnText: boolean;
    };

/** True when `text` shows nothing a reader would see: strip the invisible/ignorable
 *  formatting chars, collapse whitespace, trim. THE single answer to "is this text visually
 *  empty" — `hasVisibleContent`, the table per-cell and wrapper own-text richness checks, the
 *  residue guards and the block serializer's `readable` all route through it, so none grows
 *  its own rule. ⚠️ inline-runs.ts's `INVISIBLE_TOKEN` hand-mirrors the same class (it
 *  classifies atoms, not strings), so the two must be changed together.
 *
 *  The class is the UNION `\p{Default_Ignorable_Code_Point} ∪ \p{Cf}` (Format), not a
 *  hand-enumerated list: it covers the zero-width joiners (ZWSP/ZWNJ/ZWJ/WJ/BOM), U+00AD SOFT
 *  HYPHEN, the U+FE00–FE0F VARIATION SELECTORs, the bidi marks/isolates, the interlinear
 *  controls U+FFF9–FFFB (`Cf` but NOT Default_Ignorable — why `\p{Cf}` is unioned in) and any
 *  future format/ignorable char. Written as ALTERNATION (`A|B`), not a `[…]` class, so biome's
 *  noMisleadingCharacterClass does not flag the property escapes.
 *  BOUNDARY: format+ignorable only. A SYMBOL that merely renders blank (U+2800 BRAILLE
 *  PATTERN BLANK) is CONTENT, deliberately kept — stripping symbol categories is the unbounded
 *  direction this predicate forbids.
 *  EMPTINESS path ONLY: the OUTPUT path (`collapseWs`) must NOT strip these — VS16 is
 *  load-bearing in emoji presentation, joiners glue emoji/orthography, bidi marks order real
 *  mixed-direction text. */
export function blankAfterInvisible(text: string): boolean {
  return (
    text
      .replace(/\p{Default_Ignorable_Code_Point}|\p{Cf}/gu, "")
      .replace(/\s+/g, " ")
      .trim() === ""
  );
}

function readable(markdown: string): boolean {
  return !blankAfterInvisible(markdown.split(HARD_BREAK).join(" "));
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? "" : prefix + line))
    .join("\n");
}

export function fenceCode(body: string, lang: string): string {
  const runs = body.match(/`+/g);
  const longest = runs ? Math.max(...runs.map((run) => run.length)) : 0;
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${body}\n${fence}`;
}

export function serializeBlockNodes(nodes: readonly BlockNode[]): {
  markdown: string;
  rich: boolean;
} {
  const rendered = nodes.map((node): { markdown: string; rich: boolean } => {
    switch (node.kind) {
      case "paragraph":
        return { markdown: node.inline.markdown, rich: node.inline.rich };
      case "heading":
        return {
          markdown: `${"#".repeat(node.level)} ${node.inline.markdown.replace(/(^| )(#+)$/, "$1\\$2")}`,
          rich: true,
        };
      case "code":
        return { markdown: fenceCode(node.body, node.lang), rich: true };
      case "table":
        return { markdown: node.gfm, rich: node.content === "visible" };
      case "rule":
        return { markdown: "---", rich: true };
      case "quote": {
        const child = serializeBlockNodes(node.children);
        if (!readable(child.markdown)) {
          return { markdown: "", rich: false };
        }
        return {
          markdown: child.markdown
            .split("\n")
            .map((line) => (line === "" ? ">" : `> ${line}`))
            .join("\n"),
          rich: node.hasOwnText || child.rich,
        };
      }
      case "list": {
        let ordinal = node.start;
        let rich = false;
        const items: string[] = [];
        for (const item of node.items) {
          const children = item
            .map((child) => ({ node: child, result: serializeBlockNodes([child]) }))
            .filter(({ result }) => result.markdown !== "");
          if (!children.some(({ result }) => readable(result.markdown))) {
            continue;
          }
          const marker = node.ordered ? `${Math.min(ordinal, MAX_LIST_NUMBER)}. ` : "- ";
          const padding = " ".repeat(marker.length);
          const first = children[0].result.markdown
            .split("\n")
            .map((line, i) => (i === 0 ? marker + line : line === "" ? "" : padding + line))
            .join("\n");
          let text = first;
          for (const child of children.slice(1)) {
            text +=
              (child.node.kind === "list" ? "\n" : "\n\n") + indent(child.result.markdown, padding);
          }
          items.push(text);
          rich ||= children.some(({ result }) => result.rich);
          ordinal++;
        }
        return { markdown: items.join("\n"), rich: items.length > 0 && (node.hasOwnText || rich) };
      }
      default: {
        const exhaustive: never = node;
        return exhaustive;
      }
    }
  });
  return {
    markdown: rendered
      .map((block) => block.markdown)
      .filter(Boolean)
      .join("\n\n"),
    rich: rendered.some((block) => block.rich),
  };
}
