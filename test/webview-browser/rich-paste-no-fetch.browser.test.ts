import { expect, it } from "vitest";

import { productionPasteFixture } from "./helpers/production-paste-fixture.js";

// The recorder stores the final URL segment verbatim, so these names are
// exactly what the log holds.
const SRC = "src.png";
const SRCSET = "srcset.png";
const CONTROL = "control.png";

function probeFor(nonce: string) {
  // Absolute: the fixture runs in an about:srcdoc iframe, and a DOMParser
  // document resolves relative URLs against its own URL, so a relative probe
  // could fail to resolve and pass vacuously.
  const probe = (name: string) => `${location.origin}/__quoll-probe/${nonce}/${name}`;
  const log = async (): Promise<string[]> =>
    (await fetch(`${location.origin}/__quoll-probe-log/${nonce}`)).json();
  return { probe, log };
}

it("records a resource the fixture realm requests", async () => {
  const fixture = await productionPasteFixture();
  try {
    const { probe, log } = probeFor(crypto.randomUUID());
    new fixture.win.Image().src = probe(CONTROL);
    await expect.poll(log).toContain(CONTROL);
    expect(await log()).toEqual([CONTROL]);
  } finally {
    fixture.dispose();
  }
});

it("parses rich paste inert: a pasted remote img issues no request", async () => {
  const fixture = await productionPasteFixture();
  try {
    const { probe, log } = probeFor(crypto.randomUUID());
    // HTML-only clipboard, so rich paste owns it.
    fixture.paste({
      "text/html": `<p>hi <img src="${probe(SRC)}" srcset="${probe(SRCSET)} 2x"></p>`,
    });
    // <img> serialises to nothing, so no image widget can request anything:
    // the parser is the only possible requester.
    await fixture.posted("hi");
    new fixture.win.Image().src = probe(CONTROL);
    await expect.poll(log).toContain(CONTROL);
    expect(await log()).toEqual([CONTROL]);
  } finally {
    fixture.dispose();
  }
});
