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

function readable(markdown: string): boolean {
  return (
    markdown
      .split(HARD_BREAK)
      .join(" ")
      .replace(/\p{Default_Ignorable_Code_Point}|\p{Cf}/gu, "")
      .trim() !== ""
  );
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
