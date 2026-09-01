import { describe, expect, test } from "bun:test";
import { resolveHeaderPromptGeometry } from "../../layout/shell/chrome";
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
  test("drops out of the header prompt: same left edge, flush under the header", () => {
    for (const termWidth of [80, 100, 120, 200]) {
      const prompt = resolveHeaderPromptGeometry({ termWidth });
      const layout = resolveCommandBarPanelLayout({ ...BASE, termHeight: 40, termWidth });
      expect(layout.panelBounds.x).toBe(prompt.left);
      expect(layout.panelBounds.y).toBe(1);
    }
  });

  test("pulls the panel back on screen when it cannot start at the prompt", () => {
    const termWidth = 46;
    const layout = resolveCommandBarPanelLayout({ ...BASE, termHeight: 24, termWidth });
    expect(layout.panelBounds.x).toBeLessThan(resolveHeaderPromptGeometry({ termWidth }).left);
    expect(layout.panelBounds.x).toBeGreaterThanOrEqual(0);
  });

  test("reports the occluder in shell content coordinates, below the header", () => {
    const terminal = resolveCommandBarPanelLayout({ ...BASE, termHeight: 40, termWidth: 120 });
    expect(terminal.nativeOccluderRect.y).toBe(0);
    expect(terminal.nativeOccluderRect.x).toBe(terminal.panelBounds.x);

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
    expect(desktop.panelBounds.y).toBeCloseTo(28 / 18, 6);
    expect(desktop.nativeOccluderRect.y).toBe(0);
  });
});
