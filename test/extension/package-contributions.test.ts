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

describe("package.json contributions — Command Palette visibility", () => {
  const paletteMenus = (pkg.contributes.menus.commandPalette ?? []) as Array<{
    command: string;
    when: string;
  }>;

  it("hides quoll.format from the palette (it is meaningless without an args value)", () => {
    // Every quoll.format invocation carries an `args` action; only the five
    // keybindings supply one. A palette entry could therefore never do
    // anything, so it must not be offered.
    const entry = paletteMenus.find((m) => m.command === "quoll.format");
    expect(entry).toBeDefined();
    expect(entry?.when).toBe("false");
  });

  it("keeps quoll.formatDocument in the palette (it is the command's only entry point)", () => {
    // No keybinding contributes it, so hiding it would strand the feature. It
    // stays discoverable and explains itself when no Quoll panel is active.
    // Absence of an entry is what makes it visible (VS Code's default-visible
    // rule applies only when no entry matches) — so the absence assertion below
    // is equally satisfied by the whole commandPalette block disappearing.
    // These two pin that the block is really there for it to be absent FROM.
    expect(Array.isArray(pkg.contributes.menus?.commandPalette)).toBe(true);
    expect(paletteMenus.length).toBeGreaterThan(0);

    const entry = paletteMenus.find((m) => m.command === "quoll.formatDocument");
    expect(entry).toBeUndefined();
  });
});

interface CommandContribution {
  command: string;
  title: string;
  icon?: { light: string; dark: string };
}

interface MenuContribution {
  command: string;
  group: string;
  when: string;
}

describe("package.json contributions — editor title-bar toggle buttons", () => {
  const commandsById = new Map<string, CommandContribution>(
    (pkg.contributes.commands as CommandContribution[]).map((c) => [c.command, c])
  );
  const titleMenus = pkg.contributes.menus["editor/title"] as MenuContribution[];

  it("declares the reopen-in-text command with the file-code icon", () => {
    const cmd = commandsById.get("quoll.reopenInTextEditor");
    expect(cmd).toBeDefined();
    expect(cmd?.icon).toEqual({
      light: "media/icons/file-code-light.svg",
      dark: "media/icons/file-code-dark.svg",
    });
  });

  it("gives quoll.editWith the cat icon (reused for the into-Quoll direction)", () => {
    const cmd = commandsById.get("quoll.editWith");
    expect(cmd?.icon).toEqual({
      light: "media/icons/cat-light.svg",
      dark: "media/icons/cat-dark.svg",
    });
  });

  it("activates on the reopen-in-text command", () => {
    expect(pkg.activationEvents).toContain("onCommand:quoll.reopenInTextEditor");
  });

  it("shows the cat (into-Quoll) button on a markdown text editor, not on Quoll or a diff", () => {
    const entry = titleMenus.find((m) => m.command === "quoll.editWith");
    expect(entry).toBeDefined();
    expect(entry?.group).toBe("navigation");
    expect(entry?.when).toBe(
      "resourceExtname == '.md' && !activeCustomEditorId && !isInDiffEditor"
    );
  });

  it("shows the file-code (into-Text) button only when the Quoll editor is active", () => {
    const entry = titleMenus.find((m) => m.command === "quoll.reopenInTextEditor");
    expect(entry).toBeDefined();
    expect(entry?.group).toBe("navigation");
    expect(entry?.when).toBe("activeCustomEditorId == 'quoll.editMarkdown'");
  });

  it("wires exactly the two toggle buttons into editor/title", () => {
    const cmds = titleMenus.map((m) => m.command).sort();
    expect(cmds).toEqual(["quoll.editWith", "quoll.reopenInTextEditor"]);
  });
});
