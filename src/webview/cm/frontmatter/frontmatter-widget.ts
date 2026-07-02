// Read-only block widget that renders a file-leading YAML frontmatter fence as
// an accessible "metadata block" in place of its source lines. C8a is the pure
// projection (read-only, byte-identical round-trip); C8b adds click-to-reveal:
// a LEFT mousedown on the widget dispatches revealFrontmatterAt so the user can
// edit the raw source. The field makes the span atomic so the caret skips it.
//
// Render: a clean, all-top-level `key: value` body becomes a semantic <dl> of
// <dt>/<dd> rows (the structure the C8 a11y roll-up audits). Anything more
// complex (comments, nested mappings, sequences, anchors/tags/aliases, flow-led
// or block-scalar lines, inline-comment values) falls back to a faithful <pre>
// of the raw body — flattening complex YAML into a <dl> would show the user a
// different structure than their (preserved) source. role="region" + aria-label
// live on the root either way.
//
// eq() is keyed on `slice`: same source at the same place (frontmatter is always
// at offset 0) reuses the DOM; any source change rebuilds. `body` is a pure
// function of `slice`, so it need not participate in eq().

import { type EditorView, WidgetType } from "@codemirror/view";

import { revealFrontmatterAt } from "./reveal-state.js";

export interface FrontmatterRow {
  readonly key: string;
  readonly value: string;
}

export type ParsedFrontmatter = { kind: "pairs"; rows: FrontmatterRow[] } | { kind: "raw" };

// A clean top-level scalar mapping line. The grammar is deliberately NARROW —
// wrong `raw` is safe (a faithful <pre>), wrong `pairs` misrepresents structure
// — so anything uncertain falls back to raw (a YAML parser is out of scope, so
// we restrict the accepted grammar instead of patching exceptions). The KEY must
// be a plain identifier: starts with an ASCII alnum/`_`, then word chars, spaces,
// dots, hyphens — which rejects EVERY YAML indicator-led line in one stroke:
// block sequences (`- `), complex keys (`? `), flow collections (`{a: b}`,
// `[1,2]`), anchors (`&x`), aliases (`*x`), tags (`!!str`), comments (`#`), and
// quoted keys (`"k"`). A colon then a space-prefixed value (or nothing) follows.
const CLEAN_PAIR = /^([A-Za-z0-9_][\w .-]*):(?:[ \t]+(.*))?$/;
// VALUES are kept verbatim (so `key: {a: b}`, `key: [a, b]`, `url: https://x#frag`
// stay pairs — flow collections render fine as a one-line string) EXCEPT when the
// value would misrender as a different structure: a value that STARTS with a YAML
// node indicator — `#` (comment), `&` (anchor), `*` (alias), `!` (tag) — or carries
// an inline ` #`/`\t#` comment, or opens a block scalar (`|`/`>` with any optional
// chomp/indent indicator, e.g. `|`, `>-`, `|2-`) → raw. `^[|>]` matches the whole
// block-scalar family without enumerating the indicator suffixes.
const VALUE_RAW = /^[#&*!]|[ \t]#|^[|>]/;

export function parseFrontmatter(body: string): ParsedFrontmatter {
  const rows: FrontmatterRow[] = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "") {
      continue; // blank lines are insignificant
    }
    const match = CLEAN_PAIR.exec(line);
    if (!match) {
      return { kind: "raw" };
    }
    const value = (match[2] ?? "").trim();
    if (VALUE_RAW.test(value)) {
      return { kind: "raw" };
    }
    rows.push({ key: match[1].trim(), value });
  }
  if (rows.length === 0) {
    return { kind: "raw" }; // empty / whitespace-only body
  }
  return { kind: "pairs", rows };
}

export class FrontmatterBlockWidget extends WidgetType {
  constructor(
    /** Raw frontmatter body (between the fences). */
    readonly body: string,
    /** Full source slice `---\n…\n---` — the eq() key. */
    readonly slice: string
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof FrontmatterBlockWidget && other.slice === this.slice;
  }

  toDOM(view?: EditorView): HTMLElement {
    // Root carries the `quoll-block` marker (margin:0 measurement invariant);
    // breathing room is padding, never margin.
    const root = document.createElement("div");
    root.className = "quoll-block quoll-frontmatter-block";
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "Document metadata");

    // C8b: click-to-edit. The widget renders only when the field is COLLAPSED,
    // so a LEFT mousedown here always means "reveal". Land the caret at line-2
    // start — the first editable body line, or the closer line for an empty body
    // (`---\n---`). The `: 0` branch is dead-code defence: detect.ts returns null
    // for < 2 lines, so a collapsed widget (which only exists when a span was
    // detected) always has >= 2 lines. `view` is absent only in unit tests that
    // probe DOM structure directly — nothing to reveal without a view.
    if (view) {
      root.addEventListener("mousedown", (event) => {
        // Left button only — right/middle clicks must reach the context menu
        // and must not consume the event (matches link-handlers.ts:249).
        if (event.button !== 0) {
          return;
        }
        event.preventDefault();
        const anchor = view.state.doc.lines >= 2 ? view.state.doc.line(2).from : 0;
        revealFrontmatterAt(view, anchor);
      });
    }

    const parsed = parseFrontmatter(this.body);
    if (parsed.kind === "pairs") {
      const dl = document.createElement("dl");
      dl.className = "quoll-frontmatter-list";
      for (const row of parsed.rows) {
        const dt = document.createElement("dt");
        dt.textContent = row.key;
        const dd = document.createElement("dd");
        dd.textContent = row.value;
        dl.appendChild(dt);
        dl.appendChild(dd);
      }
      root.appendChild(dl);
    } else {
      const pre = document.createElement("pre");
      pre.className = "quoll-frontmatter-raw";
      pre.textContent = this.body;
      root.appendChild(pre);
    }

    return root;
  }

  ignoreEvent(): boolean {
    return true;
  }
}
