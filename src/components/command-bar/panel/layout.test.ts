import { describe, expect, test } from "bun:test";
import { resolveAppHeaderHeightCells } from "../../layout/shell/chrome";
import { resolveCommandBarPanelLayout } from "./layout";

const BASE = {
  cellHeightPx: 0,
  cellWidthPx: 0,
  currentRoute: null,
  hasVisibleListState: true,
  nativeListRowCount: 8,
  nativePaneChrome: false,
  showCustomMultiSelectPicker: false,
  themePickerActive: false,
  titleBarOverlay: undefined as boolean | undefined,
};

describe("command bar sheet geometry", () => {
  /**
   * The sheet hangs off the header: full width, top edge on the header's
   * bottom edge. Any gap or inset reads as a floating window again.
   */
  test("spans the window flush under the header", () => {
    for (const termWidth of [46, 80, 120, 200]) {
      const layout = resolveCommandBarPanelLayout({ ...BASE, termHeight: 40, termWidth });
      expect(layout.panelBounds).toMatchObject({ x: 0, y: resolveAppHeaderHeightCells({}), width: termWidth });
    }

    // A titlebar-overlay header is 28px tall, so its height in cells is fractional.
    const desktop = resolveCommandBarPanelLayout({
      ...BASE,
      cellHeightPx: 18,
      cellWidthPx: 8,
      nativePaneChrome: true,
      termHeight: 40,
      termWidth: 160,
      titleBarOverlay: true,
    });
    expect(desktop.panelBounds.x).toBe(0);
    expect(desktop.panelBounds.width).toBe(160);
    expect(desktop.panelBounds.y).toBeCloseTo(28 / 18, 6);
  });

  /**
   * Occluder coordinates are relative to the content area, which starts under
   * the header exactly where the sheet does, so nothing is clipped and the
   * occluder is the sheet itself.
   */
  test("reports the whole sheet as the content-relative occluder", () => {
    const terminal = resolveCommandBarPanelLayout({ ...BASE, termHeight: 40, termWidth: 120 });
    expect(terminal.nativeOccluderRect).toEqual({
      x: 0,
      y: 0,
      width: 120,
      height: terminal.panelBounds.height,
    });

    const desktop = resolveCommandBarPanelLayout({
      ...BASE,
      cellHeightPx: 18,
      cellWidthPx: 8,
      nativePaneChrome: true,
      termHeight: 40,
      termWidth: 160,
      titleBarOverlay: true,
    });
    expect(desktop.nativeOccluderRect).toEqual({
      x: 0,
      y: 0,
      width: 160,
      height: desktop.panelBounds.height,
    });
  });

  /** The bottom row of a 24-line terminal stays clear at every sheet height. */
  test("never reaches the last terminal row", () => {
    for (const termHeight of [18, 24, 40]) {
      const layout = resolveCommandBarPanelLayout({ ...BASE, termHeight, termWidth: 80 });
      expect(layout.panelBounds.y + layout.panelBounds.height).toBeLessThan(termHeight - 1);
    }
  });

  /**
   * Full width does not mean full-width labels: past ~110 cells the right
   * column would sit where nobody looks. Below the cap the columns follow
   * the window.
   */
  test("caps the results column and keeps the trailing column proportional", () => {
    const narrow = resolveCommandBarPanelLayout({ ...BASE, termHeight: 24, termWidth: 80 });
    expect(narrow.resultsInnerWidth).toBe(80 - 3 * 2);
    expect(narrow.trailingWidth).toBe(12);
    expect(narrow.labelWidth).toBe(narrow.resultsInnerWidth - narrow.trailingWidth);

    const wide = resolveCommandBarPanelLayout({ ...BASE, termHeight: 40, termWidth: 200 });
    expect(wide.resultsInnerWidth).toBe(110);
    expect(wide.labelWidth + wide.trailingWidth).toBe(110);
    expect(wide.queryDisplayWidth).toBe(110);
  });
});
