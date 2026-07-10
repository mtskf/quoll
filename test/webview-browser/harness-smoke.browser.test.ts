import { expect, it } from "vitest";

it("real browser: has a layout engine (getBoundingClientRect is non-zero)", () => {
  const el = document.createElement("div");
  el.style.width = "40px";
  el.style.height = "10px";
  document.body.appendChild(el);
  try {
    expect(el.getBoundingClientRect().width).toBeGreaterThan(0);
  } finally {
    el.remove();
  }
});
