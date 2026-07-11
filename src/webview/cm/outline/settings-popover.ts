// In-outline settings popover: 4 preset editor-surface settings, each a
// segmented radiogroup with roving tabindex. Reads editorPrefsField (via
// getPrefs) so the active segment reflects the HOST-pushed state; clicking a
// segment ONLY posts update-config (onChange) — the visual flip arrives on the
// host echo (syncFromState). Host is the single source of truth (no optimistic
// flip). A pending click disables the row until the echo (or a 2s bounded
// fallback) clears it, so a no-echo edge (read-only settings.json) degrades
// rather than hangs. DOM via createElement / createElementNS — no innerHTML.

import type { EditorPrefKey } from "../../../shared/protocol.js";
import type { EditorPrefs } from "../editor-prefs.js";
import { createCheckIcon } from "./icons.js";

/** Pending-clear fallback: if the host echo never lands (read-only settings.json
 *  edge — update() resolves, no onDidChangeConfiguration fires), clear pending
 *  and re-sync so the UI is degraded-but-not-stuck. Local echo is typically
 *  <50ms; 2s is comfortably past that. */
const PENDING_FALLBACK_MS = 2000;

/** One settings row, generic over its field name F so each row's option ids are
 *  constrained to THAT field's preset union — a typo/out-of-enum id fails
 *  compile (Global Constraint: popover options typed against the enum union). */
type Row<F extends keyof EditorPrefs> = {
  key: EditorPrefKey;
  label: string;
  field: F;
  options: ReadonlyArray<{ id: EditorPrefs[F]; label: string }>;
};

// Each entry is annotated `satisfies Row<"...">` so its ids are checked against
// the field union; the array holds the widened union of the four row types.
const ROWS: ReadonlyArray<
  Row<"fontFamily"> | Row<"fontSize"> | Row<"lineHeight"> | Row<"contentWidth">
> = [
  {
    key: "quoll.editor.fontFamily",
    label: "Font",
    field: "fontFamily",
    options: [
      { id: "default", label: "Default" },
      { id: "serif", label: "Serif" },
      { id: "sans", label: "Sans" },
    ],
  } satisfies Row<"fontFamily">,
  {
    key: "quoll.editor.fontSize",
    label: "Font size",
    field: "fontSize",
    options: [
      { id: "small", label: "Small" },
      { id: "default", label: "Default" },
      { id: "large", label: "Large" },
      { id: "x-large", label: "X-Large" },
    ],
  } satisfies Row<"fontSize">,
  {
    key: "quoll.editor.lineHeight",
    label: "Line height",
    field: "lineHeight",
    options: [
      { id: "compact", label: "Compact" },
      { id: "cozy", label: "Cozy" },
      { id: "roomy", label: "Roomy" },
    ],
  } satisfies Row<"lineHeight">,
  {
    key: "quoll.editor.contentWidth",
    label: "Content width",
    field: "contentWidth",
    options: [
      { id: "narrow", label: "Narrow" },
      { id: "medium", label: "Medium" },
      { id: "wide", label: "Wide" },
    ],
  } satisfies Row<"contentWidth">,
];

export type SettingsPopoverDeps = {
  getPrefs: () => EditorPrefs;
  onChange: (key: EditorPrefKey, value: string) => void;
  /** Called when the popover requests its own close (Escape). The outline owns
   *  the DOM unmount + aria-expanded + listener removal (closeSettings), so the
   *  popover NEVER half-closes itself — it delegates. */
  onRequestClose: () => void;
};

export type SettingsPopover = {
  el: HTMLElement;
  /** Sync the active segments from current prefs (called by the outline right
   *  after it appends `el`, and again on every host echo). */
  syncFromState(): void;
  /** Clear pending timers + remove `el` from the DOM. The outline owns the
   *  open/closed lifecycle (mount on open, destroy on close) — the popover has
   *  NO self-owned open flag, so there is no half-closed state to diverge. */
  destroy(): void;
};

export function createSettingsPopover(deps: SettingsPopoverDeps): SettingsPopover {
  const el = document.createElement("div");
  el.className = "quoll-settings-popover";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Editor settings");

  const buttonsByKey = new Map<EditorPrefKey, Map<string, HTMLButtonElement>>();
  const pendingTimers = new Map<EditorPrefKey, ReturnType<typeof setTimeout>>();

  function clearPending(key: EditorPrefKey): void {
    const timer = pendingTimers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      pendingTimers.delete(key);
    }
    const buttons = buttonsByKey.get(key);
    if (buttons) {
      for (const btn of buttons.values()) {
        btn.classList.remove("pending");
        // aria-disabled (NOT the `disabled` attribute) so a focused, pending
        // button KEEPS focus — `disabled` would dump focus to <body> and the
        // roving tabindex would lose the user's place. Restore interactivity.
        btn.removeAttribute("aria-disabled");
      }
    }
  }

  function enterPending(key: EditorPrefKey, chosen: string): void {
    const buttons = buttonsByKey.get(key);
    if (!buttons) {
      return;
    }
    for (const [id, btn] of buttons) {
      // aria-disabled keeps the element focusable (unlike `disabled`) — the
      // activate() guard below ignores clicks/keys while the row is pending, so
      // focus is preserved across select → pending → echo.
      btn.setAttribute("aria-disabled", "true");
      btn.classList.toggle("pending", id === chosen);
    }
    const prior = pendingTimers.get(key);
    if (prior !== undefined) {
      clearTimeout(prior);
    }
    pendingTimers.set(
      key,
      setTimeout(() => {
        pendingTimers.delete(key);
        clearPending(key);
        syncFromState();
      }, PENDING_FALLBACK_MS)
    );
  }

  /** Shared select path for BOTH a click and an arrow-key move (ARIA APG radio
   *  convention: arrows move focus AND select). Idempotent (active id → no-op)
   *  and pending-guarded (ignored while the row is mid-round-trip), so rapid
   *  repeats and re-selecting the active id are safe. */
  function activate(key: EditorPrefKey, field: keyof EditorPrefs, id: string): void {
    if (pendingTimers.has(key)) {
      return; // row mid-round-trip — ignore activation until the echo/fallback
    }
    if (deps.getPrefs()[field] === id) {
      return; // idempotent: active id → client-side no-op (no post)
    }
    enterPending(key, id);
    deps.onChange(key, id);
  }

  for (const row of ROWS) {
    const rowEl = document.createElement("div");
    rowEl.className = "quoll-settings-row";
    const labelEl = document.createElement("span");
    labelEl.className = "quoll-settings-label";
    labelEl.id = `quoll-settings-${row.field}-label`;
    labelEl.textContent = row.label;
    rowEl.appendChild(labelEl);

    const group = document.createElement("div");
    group.className = "quoll-settings-segments";
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-labelledby", labelEl.id);

    const valueButtons = new Map<string, HTMLButtonElement>();
    row.options.forEach((opt, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "quoll-settings-segment";
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", "false");
      btn.tabIndex = index === 0 ? 0 : -1; // roving tabindex seed; fixed by syncFromState
      btn.dataset.prefKey = row.key;
      btn.dataset.prefValue = opt.id;
      const check = createCheckIcon();
      check.classList.add("quoll-settings-check");
      const text = document.createElement("span");
      text.textContent = opt.label;
      btn.appendChild(check);
      btn.appendChild(text);
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        activate(row.key, row.field, opt.id); // idempotent + pending-guarded
      });
      valueButtons.set(opt.id, btn);
      group.appendChild(btn);
    });

    // ARIA APG radiogroup: Arrow/Home/End move roving focus AND select the
    // newly-focused radio (same activate() path as click — the idempotent +
    // pending guard makes rapid repeats safe). Space/Enter also select the
    // focused radio (native <button> fires click for those, so activate() runs
    // via the click handler — no extra key case needed).
    group.addEventListener("keydown", (e) => {
      const radios = [...group.querySelectorAll<HTMLButtonElement>("[role='radio']")];
      const current = radios.indexOf(document.activeElement as HTMLButtonElement);
      if (current === -1) {
        return;
      }
      let target = current;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        target = (current + 1) % radios.length;
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        target = (current - 1 + radios.length) % radios.length;
      } else if (e.key === "Home") {
        target = 0;
      } else if (e.key === "End") {
        target = radios.length - 1;
      } else {
        return;
      }
      e.preventDefault();
      radios[current].tabIndex = -1;
      radios[target].tabIndex = 0;
      radios[target].focus();
      // Select the newly-focused radio (APG). tabIndex re-derives on the echo
      // via syncFromState; activate() no-ops if this is already the active id.
      activate(row.key, row.field, radios[target].dataset.prefValue ?? "");
    });

    buttonsByKey.set(row.key, valueButtons);
    rowEl.appendChild(group);
    el.appendChild(rowEl);
  }

  // Escape closes ONLY the popover. The popover does NOT self-close (that would
  // leave the DOM mounted, aria-expanded stale, and the outline's document
  // pointerdown listener leaked) — it delegates to the outline's closeSettings
  // via onRequestClose, which owns unmount + aria-expanded + listener removal.
  // stopPropagation so the sidebar's own bubbling Escape→setOpen(false) handler
  // (outline-panel.ts) does not ALSO fire and close the whole sidebar.
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      deps.onRequestClose();
    }
  });

  function syncFromState(): void {
    const prefs = deps.getPrefs();
    for (const row of ROWS) {
      const active = prefs[row.field];
      const buttons = buttonsByKey.get(row.key);
      if (!buttons) {
        continue;
      }
      clearPending(row.key); // a settled state for this key clears any pending
      for (const [id, btn] of buttons) {
        const isActive = id === active;
        btn.setAttribute("aria-checked", String(isActive));
        btn.classList.toggle("active", isActive);
        btn.tabIndex = isActive ? 0 : -1; // active radio is the tabbable one
      }
    }
  }

  // Initial active-state sync so the popover is correct the instant the outline
  // appends it (before any echo).
  syncFromState();

  return {
    el,
    syncFromState,
    destroy: () => {
      for (const key of [...pendingTimers.keys()]) {
        clearPending(key);
      }
      el.remove();
    },
  };
}
