// @vitest-environment happy-dom
// Probes for the fixture module's own guarantees — the ones no behaviour test
// observes, and which therefore stay green when the mechanism is deleted.
import { describe, expect, it } from "vitest";

import { makeWidget, mockView, SRC } from "./widget-fixtures.js";

// The pair is ORDER-DEPENDENT by design: the first case dirties the body, the
// second asserts the import-time `afterEach` in widget-fixtures.ts cleaned it.
// Delete that hook and the second case reddens. It also reddens under
// `--isolate=false` when this file is not the FIRST importer of the module —
// which is correct rather than spurious: under that flag the module is
// evaluated once and the hook attaches to the first importing suite alone, so
// body cleanup genuinely is not in effect here. The probe turns that silent
// degradation into a visible failure.
//
// `armed` is why the second case cannot go vacuous. Running it ALONE — `-t
// "empty body"`, or an `.only` while iterating on the very hook it pins —
// skips the case that dirties the body, so an empty body would prove nothing
// and pass anyway. That is the exact failure mode this file exists to
// eliminate, so it gets a mechanism rather than a warning comment: the flag
// makes an isolated run RED, with a message saying why. `describe.sequential`
// holds the order if `sequence.shuffle` is ever switched on in
// vitest.config.ts.
let armed = false;

describe.sequential("widget-fixtures body cleanup", () => {
  it("leaves a mounted widget in the body (arming the probe below)", () => {
    document.body.appendChild(makeWidget(SRC).toDOM(mockView));
    expect(document.body.children.length).toBe(1);
    armed = true;
  });

  it("starts with an empty body — the import-time afterEach cleaned up", () => {
    expect(
      armed,
      "the arming case did not run — this probe is vacuous when filtered; run the whole file"
    ).toBe(true);
    expect(document.body.children.length).toBe(0);
  });
});
