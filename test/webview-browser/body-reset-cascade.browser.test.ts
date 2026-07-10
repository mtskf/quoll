// Real-browser DIFFERENTIAL test for the body-reset cascade-layer bug.
//
// VS Code injects its default webview stylesheet `body { margin:0; padding:0 20px }`
// UNLAYERED. Quoll's own body reset must beat it so the editor — and its vertical
// scrollbar — sit flush against the pane edge. A LAYERED reset silently loses: an
// unlayered normal declaration beats EVERY layered one regardless of specificity or
// source order (CSS cascade layers). happy-dom cannot model layer precedence, so
// this contract is only observable in a real browser.
//
// The differential injection is load-bearing. Without VS Code's `padding:0 20px`
// present, a layered reset would *appear* to win (nothing competes with it) and the
// assertion would be vacuous. We inject that exact rule UNLAYERED and append it
// AFTER Quoll's styles, so source order alone favours VS Code — only an
// order-independent win (higher specificity, unlayered) makes the padding collapse.
import { afterEach, expect, it } from "vitest";
import "../../src/webview/styles.css";

let vscodeDefault: HTMLStyleElement | undefined;
afterEach(() => {
  vscodeDefault?.remove();
  vscodeDefault = undefined;
});

it("real browser: Quoll body reset beats VS Code's unlayered body{padding:0 20px}", () => {
  // Reproduce VS Code's default webview stylesheet rule — UNLAYERED, appended last.
  vscodeDefault = document.createElement("style");
  vscodeDefault.textContent = "body { margin: 0; padding: 0 20px; }";
  document.head.appendChild(vscodeDefault);

  const cs = getComputedStyle(document.body);
  expect(cs.paddingLeft).toBe("0px");
  expect(cs.paddingRight).toBe("0px");
});
