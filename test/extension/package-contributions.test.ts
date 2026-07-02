import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

describe("package.json contributions — quoll.toggleEditor", () => {
  it("declares the toggle command", () => {
    const ids = pkg.contributes.commands.map((c: { command: string }) => c.command);
    expect(ids).toContain("quoll.toggleEditor");
  });

  it("activates on the toggle command", () => {
    expect(pkg.activationEvents).toContain("onCommand:quoll.toggleEditor");
  });

  it("binds Ctrl/Cmd+Alt+E to the toggle in the markdown text-editor (reverse) context", () => {
    const kbs = pkg.contributes.keybindings.filter(
      (k: { command: string }) => k.command === "quoll.toggleEditor"
    );
    // Exactly ONE binding — the reverse (text→Quoll). Forward is the CM keymap;
    // a forward workbench binding would double-fire and bounce.
    expect(kbs).toHaveLength(1);
    expect(kbs[0].key).toBe("ctrl+alt+e");
    expect(kbs[0].mac).toBe("cmd+alt+e");
    expect(kbs[0].when).toBe("editorLangId == markdown && editorTextFocus && !inDiffEditor");
  });
});
