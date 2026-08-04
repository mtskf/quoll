// @vitest-environment happy-dom
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { richHtmlPaste } from "../../../src/webview/cm/paste/rich-html-paste.js";
import { type ClipboardFlavours, firePasteAt, IMAGE_FILE } from "../helpers/clipboard-double.js";

function mount(doc: string, canWrite = true) {
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [EditorState.readOnly.of(!canWrite), richHtmlPaste({ canWrite: () => canWrite })],
    }),
  });
}

// The in-code guard needs a real Lezer tree to resolve the FencedCode node, so
// this variant loads the Markdown language. Kept separate from `mount` so the
// unrelated conversion tests stay language-free (matching the original file).
function mountMd(doc: string, canWrite = true) {
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        markdown(),
        EditorState.readOnly.of(!canWrite),
        richHtmlPaste({ canWrite: () => canWrite }),
      ],
    }),
  });
}

/** Mount a sentinel paste handler AFTER richHtmlPaste, exactly where imagePaste
 *  sits in the real editor (editor.ts), so a defer is observable directly:
 *  `defaultPrevented` cannot distinguish a defer from a consume, because CM core
 *  runs on a defer and preventDefaults on its own. `consume: true` models
 *  imagePaste ACCEPTING the event (preventDefault + return true); the default
 *  models it declining, leaving CM core to handle the paste. */
function mountWithNextHandler(doc: string, opts: { consume?: boolean } = {}) {
  const seen = { reachedNextHandler: false };
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        markdown(),
        richHtmlPaste({ canWrite: () => true }),
        EditorView.domEventHandlers({
          paste: (event) => {
            seen.reachedNextHandler = true;
            if (opts.consume) {
              event.preventDefault();
              return true;
            }
            return false;
          },
        }),
      ],
    }),
  });
  return { view, seen };
}

// `items` is the source of truth — it is what BOTH imagePaste's imageFilesFrom and
// this handler's hasImageFileItem scan, through the one shared
// `isIngestibleImageItem`. `files` is derived from it, the way a real DataTransfer
// relates the two. Both default to an empty collection rather than being left
// undefined, so what a test exercises is the kind/type/getAsFile scan itself and
// never the predicate's optional chaining. The double is shared with the imagePaste
// suite so neither side's can drift from the other's — helpers/clipboard-double.ts.
const firePaste = (view: EditorView, data: ClipboardFlavours): Event =>
  firePasteAt(view.contentDOM, data);

const REMOTE_IMG_HTML = '<img src="https://example.com/a.png">';

describe("richHtmlPaste — handler", () => {
  it("converts a rich HTML fragment and consumes the event", () => {
    const view = mount("");
    const event = firePaste(view, {
      html: "<h1>Title</h1><p><strong>hi</strong></p>",
      text: "Title\nhi",
    });
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("# Title\n\n**hi**\n");
    view.destroy();
  });
  it("blank-line separates a converted fragment pasted mid-content", () => {
    const view = mount("helloworld");
    view.dispatch({ selection: { anchor: 5 } });
    firePaste(view, { html: "<p><strong>mid</strong></p>", text: "mid" });
    expect(view.state.doc.toString()).toBe("hello\n\n**mid**\n\nworld");
    view.destroy();
  });
  it("composes prose + table on a mixed fragment", () => {
    const view = mount("");
    firePaste(view, {
      html: "<p>intro</p><table><tr><td>A</td><td>B</td></tr></table>",
      text: "intro\nA\tB",
    });
    expect(view.state.doc.toString()).toBe("intro\n\n| A | B |\n| --- | --- |\n");
    view.destroy();
  });
  it("defers when there is no text/html flavour", () => {
    // The handler stays out (returns false, no html flavour); CM's own built-in
    // plain-text paste still runs and inserts the raw text/plain unconverted (it
    // owns preventDefault for that — a CM-core behaviour, not this handler's).
    const view = mount("x");
    firePaste(view, { text: "plain" });
    expect(view.state.doc.toString()).toBe("plainx");
    view.destroy();
  });
  it("defers an unconvertible (whitespace-only) HTML fragment", () => {
    // htmlToMarkdown → null (whitespace-only) → handler returns false; CM's own
    // built-in plain-text paste inserts the raw text/plain unconverted.
    const view = mount("x");
    firePaste(view, { html: "<p>   </p>", text: "   " });
    expect(view.state.doc.toString()).toBe("   x");
    view.destroy();
  });
  it("swallows a rich paste in a read-only editor without inserting", () => {
    const view = mount("", false);
    const event = firePaste(view, { html: "<p><strong>hi</strong></p>", text: "hi" });
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("");
    view.destroy();
  });

  it("defers to plain-text paste when the caret is inside a fenced code block", () => {
    // A <pre>-bearing fragment converts to a ``` fenced snippet whose delimiters
    // would prematurely close the surrounding fence. The guard must defer (return
    // false, NO preventDefault) so CM's core plain-text paste inserts the raw
    // text/plain verbatim and the outer fence stays intact. defaultPrevented is
    // an UNRELIABLE defer signal here (CM core runs and calls preventDefault
    // itself — repo convention, see cm-list-reindent-paste.test.ts), so the
    // contract is asserted on CONTENT: the raw text lands, no fence is injected.
    const view = mountMd("```\n\n```");
    view.dispatch({ selection: { anchor: 4 } }); // inside the fence (blank interior line)
    firePaste(view, { html: "<pre>code</pre>", text: "code" });
    // Plain "code" lands verbatim; no extra ``` fence lines from the conversion.
    expect(view.state.doc.toString()).toBe("```\ncode\n```");
    view.destroy();
  });

  it("inserts a syntax-bearing conversion even when an image file rides along", () => {
    // The one consuming path that does NOT exempt an image file item, pinned
    // deliberately rather than left to be discovered. A clipboard carrying BOTH
    // real Markdown syntax and a bitmap (Word / Outlook copying a paragraph with an
    // embedded picture) can only keep one of them here: this handler has no way to
    // hand imagePaste the converted text, so deferring would drop the prose
    // entirely and paste the image alone. Keeping the prose is the smaller loss,
    // and the dominant image clipboard ("Copy image") is unaffected — its HTML is a
    // bare <img>, which converts to null and takes the exempted path instead.
    // Carrying the text through to imagePaste is tracked separately; change this
    // expectation only with that design in hand.
    const { view, seen } = mountWithNextHandler("", { consume: true });
    firePaste(view, { html: "<p><strong>bold</strong></p>", files: IMAGE_FILE });
    expect(seen.reachedNextHandler).toBe(false);
    expect(view.state.doc.toString()).toBe("**bold**\n");
    view.destroy();
  });

  it("still converts a rich fragment when the caret is outside any code block", () => {
    // Same markdown-aware mount, but the caret sits in prose: rich conversion is
    // unchanged (guard is a no-op outside code).
    const view = mountMd("intro\n\n");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    const event = firePaste(view, { html: "<h1>Title</h1>", text: "Title" });
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("intro\n\n# Title\n");
    view.destroy();
  });

  it("defers to plain-text paste when the caret is inside an indented code block", () => {
    // caretInCode covers CodeBlock (4-space indented), not just FencedCode. A
    // converted fragment's blockPrefix/blockSuffix blank lines (or the inserted
    // non-indented text itself) would terminate the indented block early.
    const view = mountMd("para\n\n    foo\n");
    view.dispatch({ selection: { anchor: 11 } }); // inside "foo", after the "f"
    firePaste(view, { html: "<h1>Title</h1>", text: "Title" });
    expect(view.state.doc.toString()).toBe("para\n\n    fTitleoo\n");
    view.destroy();
  });

  it("defers when the caret sits on the fence-opener line itself (left-bias boundary)", () => {
    // caretInCode resolves with -1 bias, so a caret immediately after the
    // opening ``` (still on that line) resolves into the FencedCode node.
    const view = mountMd("```\n\n```");
    view.dispatch({ selection: { anchor: 3 } }); // right after the opening ```
    firePaste(view, { html: "<h1>Title</h1>", text: "Title" });
    expect(view.state.doc.toString()).toBe("```Title\n\n```");
    view.destroy();
  });

  it("still converts a rich fragment when the caret is inside an inline code span (out of guard scope)", () => {
    // caretInCode only walks FencedCode / CodeBlock ancestry — inline code spans
    // are a different Lezer node and are NOT covered. This pins the current
    // scope: if caretInCode is ever widened to include inline code, this test
    // will visibly change (doc would stop showing a converted fragment here).
    const view = mountMd("para `foo` more");
    view.dispatch({ selection: { anchor: 7 } }); // inside `foo`, after the "f"
    const event = firePaste(view, { html: "<h1>Title</h1>", text: "Title" });
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("para `f\n\n# Title\n\noo` more");
    view.destroy();
  });

  it("defers a selection that starts in prose and extends into a fenced code block", () => {
    // A non-empty selection whose `from` sits in plain prose but whose `to`
    // crosses into code must still defer — checking `from` alone would miss it
    // and let a <pre>-bearing fragment inject a stray ``` inside the fence.
    const view = mountMd("before\n\n```\n\n```");
    view.dispatch({ selection: { anchor: 3, head: 11 } }); // "bef|ore\n\n```|\n\n```"
    firePaste(view, { html: "<pre>x</pre>", text: "XX" });
    // Selection is replaced by the plain-text fallback; no extra ``` from the
    // <pre> conversion, and the untouched closing fence survives intact.
    expect(view.state.doc.toString()).toBe("befXX\n\n```");
    view.destroy();
  });

  it("consumes an HTML-only paste touching code without deleting the selection", () => {
    // With no text/plain or text/uri-list fallback, deferring (return false)
    // would let CM's core paste run doPaste(view, "") — which replaces the
    // selection with nothing, deleting the selected code. The guard must
    // instead consume the event itself (preventDefault + return true) and
    // leave the document untouched.
    const view = mountMd("```\nfoo\n```");
    view.dispatch({ selection: { anchor: 4, head: 7 } }); // selects "foo"
    const event = firePaste(view, { html: "<h1>Title</h1>" }); // no text key at all
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("```\nfoo\n```");
    view.destroy();
  });

  it("consumes an HTML-only unconvertible paste over a selection without deleting it", () => {
    // Not code — ordinary prose. htmlToMarkdown returns null for an <img>-only
    // fragment (nothing convertible), and deferring would hand CM core
    // doPaste(view, "") with no text/plain and no text/uri-list, replacing the
    // selection with nothing. Copying a remote image out of a web page produces
    // exactly this clipboard, so the loss is silent and reachable.
    const view = mount("keep-this");
    view.dispatch({ selection: { anchor: 0, head: 9 } }); // whole doc selected
    const event = firePaste(view, { html: '<img src="https://example.com/a.png">' });
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("keep-this");
    view.destroy();
  });

  it("still defers an HTML-only unconvertible paste at a bare caret", () => {
    // With nothing selected there is nothing to destroy, so the handler must NOT
    // over-consume — the handlers after it (imagePaste in the real editor) still
    // need their turn at the same clipboard. defaultPrevented is useless as a defer
    // signal here (CM core runs and preventDefaults on its own), so observe the
    // deferral directly: a sentinel handler standing in for imagePaste runs only if
    // this one returned false. Pins the `from !== to` half of the guard.
    let reachedNextHandler = false;
    const view = new EditorView({
      state: EditorState.create({
        doc: "keep-this",
        extensions: [
          richHtmlPaste({ canWrite: () => true }),
          EditorView.domEventHandlers({
            paste: () => {
              reachedNextHandler = true;
              return false;
            },
          }),
        ],
      }),
    });
    view.dispatch({ selection: { anchor: 4 } });
    firePaste(view, { html: '<img src="https://example.com/a.png">' });
    expect(reachedNextHandler).toBe(true);
    expect(view.state.doc.toString()).toBe("keep-this");
    view.destroy();
  });

  it("consumes an unconvertible HTML-only paste carrying a NON-image file over a selection", () => {
    // The file item belongs to no handler: imagePaste accepts only kind === "file"
    // AND an image/ type, so it declines a PDF and hands the event back to CM core,
    // whose doPaste("") — there is no text/plain — replaces the selection with
    // nothing. The proxy that decides whether to defer must therefore be a SUBSET
    // of imagePaste's own scan; when it was `files.length > 0` this exact clipboard
    // emptied the document.
    const view = mount("keep-this");
    view.dispatch({ selection: { anchor: 0, head: 9 } }); // whole doc selected
    const event = firePaste(view, {
      html: REMOTE_IMG_HTML,
      files: [{ type: "application/pdf" }],
    });
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("keep-this");
    view.destroy();
  });

  it("consumes an unconvertible HTML-only paste whose image item yields no File", () => {
    // Matches on kind + type, but getAsFile() returns null, so imageFilesFrom skips
    // it and imagePaste declines exactly as it does for the PDF above. Deferring on
    // kind + type alone would leave this one clipboard shape still routing into
    // doPaste("") — the same over-match, one step narrower.
    const view = mount("keep-this");
    view.dispatch({ selection: { anchor: 0, head: 9 } });
    const event = firePaste(view, {
      html: REMOTE_IMG_HTML,
      files: [{ type: "image/png", file: null }],
    });
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("keep-this");
    view.destroy();
  });

  it("consumes an unconvertible HTML-only paste whose image item returns undefined", () => {
    // The same shape one step further out: imagePaste keeps a file with
    // `if (file)`, so it declines an UNDEFINED getAsFile() exactly as it declines a
    // null one. This handler shipped a `!== null` restatement that matched where
    // imagePaste does not — it deferred, imagePaste declined, and CM's doPaste("")
    // emptied the selection. Sharing isIngestibleImageItem is what makes that
    // unconstructible; this is the document-level observation of it, and
    // cm-image-paste.test.ts pins the same shape at the predicate.
    const view = mount("keep-this");
    view.dispatch({ selection: { anchor: 0, head: 9 } });
    const event = firePaste(view, {
      html: REMOTE_IMG_HTML,
      files: [{ type: "image/png", file: undefined }],
    });
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("keep-this");
    view.destroy();
  });

  it("defers an unconvertible HTML-only paste over a selection when an image file rides along", () => {
    // The mirror image of the two above: imagePaste WILL act on this clipboard, so
    // consuming here would starve the only handler that can perform the paste and
    // the image would be silently dropped. Deferring is safe over a selection
    // precisely because imagePaste consumes the event itself.
    const { view, seen } = mountWithNextHandler("keep-this", { consume: true });
    view.dispatch({ selection: { anchor: 0, head: 9 } });
    firePaste(view, { html: REMOTE_IMG_HTML, files: IMAGE_FILE });
    expect(seen.reachedNextHandler).toBe(true);
    expect(view.state.doc.toString()).toBe("keep-this");
    view.destroy();
  });

  it("defers an image-file paste over a selection inside a code block", () => {
    // The caretInCode consume branch needs the same image exemption as the
    // null-conversion branch: without it, pasting a copied image while code was
    // selected was preventDefault'd here and never reached imagePaste — the paste
    // left no trace at all.
    const { view, seen } = mountWithNextHandler("```\nfoo\n```", { consume: true });
    view.dispatch({ selection: { anchor: 4, head: 7 } }); // selects "foo"
    firePaste(view, { html: REMOTE_IMG_HTML, files: IMAGE_FILE });
    expect(seen.reachedNextHandler).toBe(true);
    expect(view.state.doc.toString()).toBe("```\nfoo\n```");
    view.destroy();
  });

  it("still defers an HTML-only paste at a bare caret inside a code block", () => {
    // The guard's whole justification is "deferring would delete the selection",
    // which is vacuous at a caret: CM's doPaste("") with nothing selected is a
    // no-op. Consuming there would swallow the event to protect nothing, and the
    // handlers after this one would never get their turn at the same clipboard.
    const { view, seen } = mountWithNextHandler("```\nfoo\n```");
    view.dispatch({ selection: { anchor: 5 } }); // bare caret inside "foo"
    firePaste(view, { html: "<h1>Title</h1>" }); // no text/plain at all
    expect(seen.reachedNextHandler).toBe(true);
    expect(view.state.doc.toString()).toBe("```\nfoo\n```");
    view.destroy();
  });

  it("defers to CM's uri-list fallback for an in-code paste with no text/plain", () => {
    // hasPlainFallback is also true for text/uri-list (mirrors CM core's own
    // getData("text/plain") || getData("text/uri-list")). With no text/plain but a
    // uri-list present, the guard defers and CM core inserts the uri-list value.
    // Dropping the uri-list clause would fall through to consume, leaving the
    // selection untouched instead of replaced — making this assertion non-vacuous.
    const view = mountMd("```\nfoo\n```");
    view.dispatch({ selection: { anchor: 4, head: 7 } }); // selects "foo"
    firePaste(view, { html: "<h1>Title</h1>", uriList: "https://example.com" });
    expect(view.state.doc.toString()).toBe("```\nhttps://example.com\n```");
    view.destroy();
  });

  it("consumes an HTML-only unconvertible paste in code without deleting the selection", () => {
    // Whitespace-only HTML → htmlToMarkdown returns null. The guard now runs BEFORE
    // that check, so an HTML-only clipboard (no text/plain) over a code selection is
    // consumed (preventDefault, no dispatch) instead of falling through to the
    // md===null defer, which would let CM's core doPaste("") delete the selection.
    const view = mountMd("```\nfoo\n```");
    view.dispatch({ selection: { anchor: 4, head: 7 } }); // selects "foo"
    const event = firePaste(view, { html: "<p>   </p>" }); // whitespace-only, no text
    expect(event.defaultPrevented).toBe(true); // we consume it (not a defer) → reliable
    expect(view.state.doc.toString()).toBe("```\nfoo\n```"); // selection untouched
    view.destroy();
  });
});

describe("richHtmlPaste — plain-text-like fragments defer", () => {
  // The reported bug: a plain Markdown checklist copied out of a text editor
  // arrives with a presentational `text/html` flavour. Converting it escaped the
  // user's own markers and merged the blank-line-separated items.
  const CHECKLIST_HTML =
    '<div style="color:#ccc"><div><span>- [ ] first</span></div><br>' +
    "<div><span>- [ ] second</span></div></div>";
  const CHECKLIST_PLAIN = "- [ ] first\n\n- [ ] second";

  it("inserts the clipboard's plain text verbatim, unescaped and unmerged", () => {
    const view = mount("");
    firePaste(view, { html: CHECKLIST_HTML, text: CHECKLIST_PLAIN });
    expect(view.state.doc.toString()).toBe(CHECKLIST_PLAIN);
    view.destroy();
  });

  it("inserts the clipboard's plain text over a non-empty selection", () => {
    // Select-then-paste-over is the dominant way the reported bug is met, and the
    // observation it makes — the selection is REPLACED by the plain bytes, not
    // preserved and not escaped — is one no caret-based test can make.
    const view = mount("old-text");
    view.dispatch({ selection: { anchor: 0, head: 8 } }); // whole doc selected
    firePaste(view, { html: CHECKLIST_HTML, text: CHECKLIST_PLAIN });
    expect(view.state.doc.toString()).toBe(CHECKLIST_PLAIN);
    view.destroy();
  });

  it("defers a syntax-free fragment that arrives with an image file and no text/plain", () => {
    // A caption <div> beside a copied image. Converting and consuming here (the
    // behaviour before the image exemption) starved imagePaste and dropped the
    // image; deferring keeps the image, at the cost of the caption text — the same
    // trade the <br> case below makes, and the one the user can actually see.
    const { view, seen } = mountWithNextHandler("", { consume: true });
    firePaste(view, { html: "<div>caption</div>", files: IMAGE_FILE });
    expect(seen.reachedNextHandler).toBe(true);
    expect(view.state.doc.toString()).toBe("");
    view.destroy();
  });

  it("still converts when the fragment carries real Markdown syntax", () => {
    const view = mount("");
    const event = firePaste(view, {
      html: "<p>Hello <strong>bold</strong> - [ ] not a task</p>",
      text: "Hello bold - [ ] not a task",
    });
    expect(event.defaultPrevented).toBe(true);
    // The deliberate escaping is intact: the stray task marker stays literal.
    expect(view.state.doc.toString()).toBe("Hello **bold** - \\[ \\] not a task\n");
    view.destroy();
  });

  it("defers to CM's uri-list fallback when a syntax-free fragment has no text/plain", () => {
    // hasPlainFallback mirrors CM core's own getData("text/plain") ||
    // getData("text/uri-list"). The other tests here all supply text/plain, so
    // without this one the uri-list clause could be deleted from this defer and
    // the suite would stay green (the sole existing uri-list test covers the
    // caretInCode site instead).
    const view = mount("");
    firePaste(view, { html: "<div>example.com</div>", uriList: "https://example.com" });
    expect(view.state.doc.toString()).toBe("https://example.com");
    view.destroy();
  });

  it("converts a syntax-free fragment when there is no text/plain to fall back to", () => {
    const view = mount("");
    const event = firePaste(view, { html: "<p>only html</p>" });
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("only html\n");
    view.destroy();
  });

  it("pastes text that merely LOOKS like Markdown as Markdown (accepted trade-off)", () => {
    // Deliberate, and the sharpest edge of this design — see "The objection" in
    // the plan. A `<p>` holding literal `# Release notes` is not rich content, so
    // the user's own bytes go in verbatim and the heading activates, exactly as it
    // already does when the source app attaches no `text/html` flavour at all.
    // Change this expectation only with a matching decision record.
    const view = mount("");
    firePaste(view, { html: "<p># Release notes</p>", text: "# Release notes" });
    expect(view.state.doc.toString()).toBe("# Release notes");
    view.destroy();
  });

  it("loses a lone <br> hard break to the plain fallback (accepted trade-off)", () => {
    // The second edge of the same design. A <br> is line structure, not Markdown
    // syntax, so a syntax-free fragment still defers and the clipboard's own bytes
    // win: before this defer existed the converter inserted "a\\\nb" (a Markdown
    // HARD break); now the plain flavour's "a\nb" lands, which renders as "a b".
    // We accept the softened break rather than re-escaping hand-written Markdown —
    // setting the richness flag on <br> would send the reported bug straight back,
    // since the checklist fragment above is <br>-separated.
    // Change this expectation only with a matching decision record.
    const view = mount("");
    firePaste(view, { html: "<div>a<br>b</div>", text: "a\nb" });
    expect(view.state.doc.toString()).toBe("a\nb");
    view.destroy();
  });

  it("stays inert in a read-only editor on the defer path too", () => {
    // The defer returns BEFORE the handler's own canWrite() check, so read-only
    // safety on this path is inherited from CM's builtin paste handler, which
    // early-returns on view.state.readOnly.
    //
    // What this test does NOT pin: the EditorState.readOnly ↔ opts.canWrite
    // coupling that makes the inheritance sound. `mount` derives both from one
    // flag, so a divergence between them is not constructible here and this test
    // would stay green if they came apart. That coupling is owned by the
    // `editableComp` reconfiguration in editor.ts and belongs with it. What this
    // DOES pin is the end state a user can observe: a read-only document does not
    // accept a deferred paste.
    const view = mount("", false);
    firePaste(view, { html: CHECKLIST_HTML, text: CHECKLIST_PLAIN });
    expect(view.state.doc.toString()).toBe("");
    view.destroy();
  });

  it("inserts a plain-text-shaped fragment inline at the caret, without block framing", () => {
    // Deliberate behaviour change (see "Behaviour change" below): block framing
    // is for CONVERTED rich content. A clipboard that is really just the word
    // "mid" must land where the caret is, exactly as a no-`text/html` paste does.
    const view = mount("helloworld");
    view.dispatch({ selection: { anchor: 5 } });
    firePaste(view, { html: "<p>mid</p>", text: "mid" });
    expect(view.state.doc.toString()).toBe("hellomidworld");
    view.destroy();
  });
});
