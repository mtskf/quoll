// Edit `variations` per task to compare CSS tweaks side-by-side in real Chromium.
// Each variation renders the SAME `doc` in an isolated iframe with its `css` injected.
export default {
  doc: "test/markdown/fixtures/nested-lists.md", // repo-root-relative; or use `content: "..."`
  theme: "light", // "light" | "dark"
  variations: [
    { label: "baseline", css: "" },
    // { label: "example — wider gap", css: ".cm-content { letter-spacing: 0; }" },
  ],
};
