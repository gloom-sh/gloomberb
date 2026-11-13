import { expect, test } from "bun:test";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { contrastRatio } from "../../theme/color-utils";
import { getThemeColors } from "../../theme/colors";
import { getThemeIds } from "../../theme/themes";
import { Box, Span, Text, TextAttributes } from "../../ui";
import { buttonLabelAttributes, buttonShortcutColor, markButtonContent, resolveButtonColors, type ButtonVariant } from "./button";

// colorblind-light's welcome card drew Connect's Alt+Enter in the page's dim text on the primary fill: 2.07:1.
test("a button's key reads on its own fill in every theme, and stays the quiet dim text beside an unfilled one", () => {
  for (const id of getThemeIds()) {
    const colors = getThemeColors(id);
    for (const [variant, active, tone] of [["primary", false], ["danger", false], ["secondary", true], ["primary", false, "positive"]] as const) {
      const palette = resolveButtonColors(variant as ButtonVariant, active, false, colors, tone);
      const key = buttonShortcutColor(palette, false, colors);
      expect(key).toBe(palette.fg);
      if (contrastRatio(key, palette.bg!) < contrastRatio(colors.textDim, palette.bg!)) {
        throw new Error(`${id} ${variant}: its key reads worse than the dim text did`);
      }
    }
    for (const variant of ["secondary", "ghost", "plain"] as const) {
      expect(buttonShortcutColor(resolveButtonColors(variant, false, false, colors), false, colors)).toBe(colors.textDim);
    }
    expect(buttonShortcutColor(resolveButtonColors("primary", false, true, colors), true, colors)).toBe(colors.textMuted);
  }
  const light = getThemeColors("colorblind-light");
  const connect = resolveButtonColors("primary", false, false, light);
  expect(contrastRatio(buttonShortcutColor(connect, false, light), connect.bg!)).toBeGreaterThanOrEqual(4.5);
});

// A focused primary took the selection fill: on the Add Alert dialog it went
// from the accent fill to dim grey, so focus made it the quieter of the two.
test("focus keeps a filled button's fill and marks its label, and fills an unfilled one with the selection", () => {
  for (const id of getThemeIds()) {
    const colors = getThemeColors(id);
    for (const variant of ["primary", "danger"] as const) {
      expect(resolveButtonColors(variant, true, false, colors)).toEqual(resolveButtonColors(variant, false, false, colors));
      expect(buttonLabelAttributes(variant, true, false)).toBe(TextAttributes.BOLD | TextAttributes.UNDERLINE);
    }
    expect(resolveButtonColors("primary", true, false, colors, "negative")).toEqual(resolveButtonColors("primary", false, false, colors, "negative"));
    expect(resolveButtonColors("secondary", true, false, colors).bg).toBe(colors.selected);
    expect(buttonLabelAttributes("secondary", true, false)).toBe(TextAttributes.BOLD);
    expect(buttonLabelAttributes("primary", false, false)).toBe(0);
  }
});

// A primary drawn from children had no mark at all: its fill stays, and only a label was marked.
test("a focused filled button drawn from children marks the text in it as a label is marked", () => {
  const cue = buttonLabelAttributes("primary", true, false);
  const Own = () => null;
  const marked = markButtonContent([
    createElement(Text, { key: "a", attributes: TextAttributes.DIM }, "Buy"),
    createElement(Box, { key: "b" }, createElement(Span, null, "AAPL")),
    createElement(Own, { key: "c" }),
    "plain",
  ], cue) as ReactNode[];
  const attributes = (node: ReactNode) => (isValidElement(node) ? (node as ReactElement<{ attributes?: number }>).props.attributes : undefined);
  expect(attributes(marked[0])).toBe(TextAttributes.DIM | cue);
  const inBox = (marked[1] as ReactElement<{ children: ReactNode[] }>).props.children;
  expect(attributes([inBox].flat()[0])).toBe(cue);
  // A component of the caller's draws its own text, and a string is not a Text.
  expect(attributes(marked[2])).toBeUndefined();
  expect(marked[3]).toBe("plain");
  expect(markButtonContent("Buy", 0)).toBe("Buy");
});
