<!-- case: no frontmatter; `---` thematic breaks appear mid-document, must round-trip intact -->
# Document heading

First paragraph before any thematic break.

---

Second paragraph between two thematic breaks. A naive whole-document
scan for `---` pairs would have swallowed this; the AST-driven detector
is anchored to the start of the document and leaves these alone.

---

Closing paragraph.
