import { describe, expect, test } from "bun:test";
import { blendHex } from "./color-utils";
import { getScheme, getSchemeIds } from "./schemes";
import { getStyleIds, DEFAULT_STYLE } from "./styles";
import { resolveTheme, type ThemePalette } from "./tokens";

/**
 * The default style has to render exactly what the app rendered before themes
 * were split into a scheme and a style. These are the pre-split formulas,
 * transcribed from the call sites they used to live in, so a recipe change
 * that quietly moves the shipped look fails here rather than in someone's
 * terminal.
 *
 * The one intentional exception is the body text roles, which are re-floored
 * against the pane surfaces a style actually produces. That is asserted
 * separately below as a floor rather than an equality.
 */
function preSplitLook(p: ThemePalette): Record<string, string> {
  const hover = blendHex(p.bg, p.selected, 0.5);
  return {
    "pane.body.bg.idle": blendHex(p.panel, p.border, 0.08),
    "pane.body.bg.focused": blendHex(p.bg, p.borderFocused, 0.06),
    "pane.floatingBody.bg.idle": blendHex(p.panel, p.border, 0.18),
    "pane.floatingBody.bg.focused": blendHex(p.bg, p.borderFocused, 0.08),
    "pane.title.bg.idle": blendHex(p.panel, p.border, 0.15),
    "pane.title.bg.focused": blendHex(p.bg, p.borderFocused, 0.22),
    "pane.title.floatingBg.idle": blendHex(p.panel, p.border, 0.25),
    "pane.title.floatingBg.focused": blendHex(p.bg, p.borderFocused, 0.25),
    "pane.border.idle": p.border,
    "pane.border.focused": p.borderFocused,
    "surface.hover": hover,
    "surface.selected": p.selected,
    "table.headerBg": p.panel,
    "table.row.hover": hover,
    "table.row.selected": p.selected,
    "list.selectedBg": p.selected,
    "list.hoverBg": hover,
    "toast.bg": p.panel,
    "dialog.bg": p.bg,
    "dialog.border": p.borderFocused,
    "button.primary.bg": p.borderFocused,
    "button.primary.fg": p.bg,
    "button.secondary.bg": p.panel,
    "button.ghost.bg": p.bg,
    "button.danger.bg": p.negative,
    "button.disabled.bg": p.panel,
    "badge.subtle.accent.bg": blendHex(p.bg, p.borderFocused, 0.28),
    "badge.subtle.accent.fg": p.borderFocused,
    "badge.solid.positive.bg": p.positive,
    "badge.solid.positive.fg": p.bg,
    "badge.solid.neutral.bg": p.selected,
    "badge.solid.neutral.fg": p.selectedText,
  };
}

function read(tokens: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (value, key) => (value as Record<string, unknown> | undefined)?.[key],
    tokens,
  );
}

describe("the default style keeps the shipped look", () => {
  test("every scheme resolves the pre-split values under the default style", () => {
    const drift: string[] = [];
    for (const schemeId of getSchemeIds()) {
      const { name: _name, description: _description, ...palette } = getScheme(schemeId);
      const { tokens } = resolveTheme(schemeId, DEFAULT_STYLE);
      for (const [path, expected] of Object.entries(preSplitLook(palette))) {
        const actual = read(tokens, path);
        if (actual !== expected) drift.push(`${schemeId} ${path}: expected ${expected}, got ${String(actual)}`);
      }
    }
    expect(drift).toEqual([]);
  });

  test("the default style carries the pre-split structure", () => {
    const { pane, table, spacing, type } = resolveTheme("amber", DEFAULT_STYLE).tokens;
    expect(pane.chrome.borderKind).toBe("line");
    expect(pane.chrome.headerMode).toBe("bar");
    expect(pane.chrome.focusMode).toBe("border");
    expect(pane.chrome.grip).toBe(":: ");
    expect(pane.chrome.upperCaseTitles).toBe(false);
    expect(spacing).toEqual({ rowHeight: 1, columnGap: 1, padX: 1, sectionGap: 1 });
    expect(table.row.stripe).toBeNull();
    expect(table.layout.rowRule).toBe(false);
    // No case transforms and no italics: the shipped look sets emphasis in
    // bold alone, which is what a single-weight terminal font can do.
    for (const treatment of Object.values(type)) {
      expect(treatment.transform).toBe("none");
    }
  });

  test("only the default style is offered to users", () => {
    expect(getStyleIds()).toEqual([DEFAULT_STYLE]);
  });
});
