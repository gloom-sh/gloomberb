import { describe, expect, test } from "bun:test";
import { resolveAppHeaderHeightCells, resolveHeaderPromptGeometry } from "../../layout/shell/chrome";
import { resolveCommandBarPanelLayout } from "./layout";

const BASE = {
  cellHeightPx: 0,
  cellWidthPx: 0,
  currentRoute: null,
  hasRootFeedback: false,
  hasVisibleListState: true,
  nativeListRowCount: 8,
  nativePaneChrome: false,
  showCustomMultiSelectPicker: false,
  themePickerActive: false,
  titleBarOverlay: undefined as boolean | undefined,
};

const DESKTOP = {
  ...BASE,
  cellHeightPx: 18,
  cellWidthPx: 8,
  nativePaneChrome: true,
  nativeWindowChrome: true,
  titleBarOverlay: true,
};

describe("command bar sheet geometry", () => {
  /**
   * The sheet is the header prompt expanding downward: same left edge, same
   * width, top edge on the header's bottom edge. Any drift between the two
   * reads as a banner, or a floating window, hanging near the prompt.
   */
  test("shares the prompt's left edge and width on every window size", () => {
    for (const termWidth of [46, 80, 120, 200]) {
      const layout = resolveCommandBarPanelLayout({ ...BASE, termHeight: 40, termWidth });
      const prompt = resolveHeaderPromptGeometry({ termWidth });
      expect(layout.panelBounds).toEqual({
        x: prompt.left,
        y: resolveAppHeaderHeightCells({}),
        width: prompt.width,
        height: layout.panelBounds.height,
      });
      expect(layout.nativeOccluderRect).toEqual({
        x: prompt.left,
        y: 0,
        width: prompt.width,
        height: layout.panelBounds.height,
      });
    }

    // A titlebar-overlay header is 28px tall, so its height in cells is fractional.
    const desktop = resolveCommandBarPanelLayout({ ...DESKTOP, termHeight: 40, termWidth: 200 });
    const desktopPrompt = resolveHeaderPromptGeometry({
      nativePaneChrome: true,
      nativeWindowChrome: true,
      termWidth: 200,
      titleBarOverlay: true,
    });
    expect(desktop.panelBounds.x).toBe(desktopPrompt.left);
    expect(desktop.panelBounds.width).toBe(desktopPrompt.width);
    expect(desktop.panelBounds.y).toBeCloseTo(28 / 18, 6);
  });

  /**
   * The selection bar is the row box, padding included, so the columns have
   * to add back up to the sheet: nothing capped short of it, nothing past it.
   */
  test("fills the sheet with the results columns", () => {
    const terminal = resolveCommandBarPanelLayout({ ...BASE, termHeight: 40, termWidth: 200 });
    expect(terminal.queryDisplayWidth + terminal.contentPadding * 2).toBe(terminal.panelBounds.width);
    expect(terminal.labelWidth + terminal.trailingWidth).toBe(terminal.resultsInnerWidth);
    expect(terminal.trailingWidth).toBe(12);

    const desktop = resolveCommandBarPanelLayout({ ...DESKTOP, termHeight: 40, termWidth: 200 });
    expect(desktop.queryDisplayWidth + desktop.contentPadding * 2 + desktop.nativePanelPaddingColumns)
      .toBe(desktop.panelBounds.width);
  });

  /**
   * A 24-row terminal keeps its 16 rows; from there the list takes about
   * 55% of the window, up to 26 rows, so a tall window shows more of a
   * multi-line document list. The chrome row and its blank line come out of
   * the same budget, so the sheet's footprint does not grow when they show.
   */
  test("grows with the window past 24 rows and caps at 26", () => {
    const expected: Array<[number, number]> = [[24, 16], [40, 22], [60, 26]];
    for (const [termHeight, bodyHeight] of expected) {
      const plain = resolveCommandBarPanelLayout({ ...BASE, termHeight, termWidth: 120 });
      expect(plain.bodyHeight).toBe(bodyHeight);
      expect(plain.hasChromeRow).toBe(false);
      expect(plain.panelBounds.height).toBe(bodyHeight + 2);

      const withChrome = resolveCommandBarPanelLayout({ ...BASE, hasRootFeedback: true, termHeight, termWidth: 120 });
      expect(withChrome.hasChromeRow).toBe(true);
      expect(withChrome.panelBounds.height).toBe(withChrome.bodyHeight + 4);
      expect(withChrome.panelBounds.height).toBeLessThanOrEqual(plain.panelBounds.height);
    }
  });

  /** The bottom rows of a short terminal stay clear at every sheet height. */
  test("never reaches the last terminal row", () => {
    for (const termHeight of [18, 24, 40]) {
      for (const hasRootFeedback of [false, true]) {
        const layout = resolveCommandBarPanelLayout({ ...BASE, hasRootFeedback, termHeight, termWidth: 80 });
        expect(layout.panelBounds.y + layout.panelBounds.height).toBeLessThan(termHeight - 1);
      }
    }
  });
});
