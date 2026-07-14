// Curated registry of fence language options for the language picker. Its own
// module (single source) so PR2's syntax highlighting can EXTEND each entry
// (e.g. an optional `highlightId`/`aliases`) without the picker menu and the
// highlightable set drifting apart. PR1 uses only `value`/`label`.
//
// `value` is the canonical fence identifier written into the info string; it is
// always a plain language identifier (no whitespace/braces), so the picker's
// output is a known-safe token. The leading empty-value entry is the "clear the
// language" (bare fence) choice.

export type LanguageOption = {
  /** Canonical fence identifier written to the info string ("" clears it). */
  value: string;
  /** Human-facing menu label. */
  label: string;
};

export const LANGUAGE_OPTIONS: readonly LanguageOption[] = [
  { value: "", label: "Plain text" },
  { value: "js", label: "JavaScript" },
  { value: "ts", label: "TypeScript" },
  { value: "jsx", label: "JSX" },
  { value: "tsx", label: "TSX" },
  { value: "json", label: "JSON" },
  { value: "html", label: "HTML" },
  { value: "css", label: "CSS" },
  { value: "python", label: "Python" },
  { value: "java", label: "Java" },
  { value: "c", label: "C" },
  { value: "cpp", label: "C++" },
  { value: "csharp", label: "C#" },
  { value: "go", label: "Go" },
  { value: "rust", label: "Rust" },
  { value: "ruby", label: "Ruby" },
  { value: "php", label: "PHP" },
  { value: "shell", label: "Shell" },
  { value: "sql", label: "SQL" },
  { value: "yaml", label: "YAML" },
  { value: "markdown", label: "Markdown" },
  { value: "xml", label: "XML" },
];
