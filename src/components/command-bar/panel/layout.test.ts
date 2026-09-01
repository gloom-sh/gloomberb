import { describe, expect, test } from "bun:test";
import { resolveAppHeaderHeightCells, resolveHeaderPromptGeometry } from "../../layout/shell/chrome";
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

describe("command bar panel anchoring", () => {
  /**
   * The panel replaces the header prompt rather than hanging beneath it, so the
   * query the user types stays on the row they clicked. Anchoring it one row
   * lower put the text in a second field under a prompt that looked empty.
   */
  test("opens over the header prompt, sharing its left edge and its row", () => {
    for (const termWidth of [80, 100, 120, 200]) {
      const prompt = resolveHeaderPromptGeometry({ termWidth });
      const layout = resolveCommandBarPanelLayout({ ...BASE, termHeight: 40, termWidth });
      expect(layout.panelBounds.x).toBe(prompt.left);
      expect(layout.panelBounds.y).toBe(0);
    }
  });

  test("pulls the panel back on screen when it cannot start at the prompt", () => {
    const termWidth = 46;
    const layout = resolveCommandBarPanelLayout({ ...BASE, termHeight: 24, termWidth });
    expect(layout.panelBounds.x).toBeLessThanOrEqual(
      resolveHeaderPromptGeometry({ termWidth }).left,
    );
    expect(layout.panelBounds.x).toBeGreaterThanOrEqual(0);
  });

  /**
   * Occluder coordinates are relative to the content area, which starts below
   * the header. The panel begins above that origin now, so the covered header
   * rows have to be clipped off instead of reported as a negative offset that
   * would shift the occluder up into the header.
   */
  test("clips the header rows out of the content-relative occluder", () => {
    const terminal = resolveCommandBarPanelLayout({ ...BASE, termHeight: 40, termWidth: 120 });
    expect(terminal.nativeOccluderRect.y).toBe(0);
    expect(terminal.nativeOccluderRect.x).toBe(terminal.panelBounds.x);
    expect(terminal.nativeOccluderRect.height).toBe(
      terminal.panelBounds.height - resolveAppHeaderHeightCells({}),
    );

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
    expect(desktop.panelBounds.y).toBe(0);
    expect(desktop.nativeOccluderRect.y).toBe(0);
    expect(desktop.nativeOccluderRect.height).toBeCloseTo(
      desktop.panelBounds.height - 28 / 18,
      6,
    );
  });
});
