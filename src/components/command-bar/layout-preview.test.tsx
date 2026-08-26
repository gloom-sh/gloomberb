import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "../../renderers/opentui/test-utils";
import { cloneLayout, createDefaultConfig } from "../../types/config";
import {
  buildLayoutPreviewRects,
  CommandBarLayoutPreview,
  LAYOUT_PREVIEW_ROWS,
} from "./layout-preview";
import { resolveCommandBarPanelLayout } from "./panel/layout";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(async () => {
  await act(async () => {
    testSetup?.renderer.destroy();
    testSetup = undefined;
  });
});

const layout = (() => {
  const next = cloneLayout(createDefaultConfig("/tmp/gloomberb-test").layout);
  next.floating = [{ instanceId: "chat:main", x: 40, y: 6, width: 30, height: 10 }];
  next.detached = [{ instanceId: "quote-monitor:main", x: 70, y: 2, width: 24, height: 8 }];
  return next;
})();

function panelLayout(termHeight: number, hasSelectedLayoutPreview: boolean, nativePaneChrome = false) {
  return resolveCommandBarPanelLayout({
    cellHeightPx: 18,
    cellWidthPx: 8,
    currentRoute: null,
    hasSelectedLayoutPreview,
    hasVisibleListState: true,
    nativeListRowCount: 6,
    nativePaneChrome,
    showCustomMultiSelectPicker: false,
    termHeight,
    termWidth: 100,
    themePickerActive: false,
    titleBarOverlay: undefined,
  });
}

describe("selected layout preview sizing", () => {
  test("reserves preview rows only when the panel has room for them", () => {
    const tall = panelLayout(30, true);
    const short = panelLayout(18, true);
    const tallWithoutSelection = panelLayout(30, false);

    expect(tall.layoutPreviewRows).toBe(LAYOUT_PREVIEW_ROWS);
    // The terminal panel is fixed height, so the schematic comes out of the list.
    expect(tall.listBodyHeight).toBe(tallWithoutSelection.listBodyHeight - LAYOUT_PREVIEW_ROWS);
    expect(tall.panelBounds.height).toBe(tallWithoutSelection.panelBounds.height);

    expect(short.layoutPreviewRows).toBe(0);
    expect(short.listBodyHeight).toBe(panelLayout(18, false).listBodyHeight);
  });

  test("grows the native panel instead of shrinking a row-sized list", () => {
    const withPreview = panelLayout(40, true, true);
    const withoutPreview = panelLayout(40, false, true);

    expect(withPreview.layoutPreviewRows).toBe(LAYOUT_PREVIEW_ROWS);
    expect(withPreview.listBodyHeight).toBe(withoutPreview.listBodyHeight);
    expect(withPreview.panelBounds.height).toBe(withoutPreview.panelBounds.height + LAYOUT_PREVIEW_ROWS);
    // A window too short to gain the rows keeps the list untouched instead.
    expect(panelLayout(12, true, true).layoutPreviewRows).toBe(0);
  });
});

test("maps docked, floating, and detached panes into in-bounds preview rects", () => {
  const bounds = { width: 40, height: LAYOUT_PREVIEW_ROWS };
  const rects = buildLayoutPreviewRects(layout, bounds, { width: 120, height: 40 });

  expect(rects.filter((entry) => entry.kind === "docked").length).toBe(3);
  expect(rects.filter((entry) => entry.kind === "floating").length).toBe(1);
  expect(rects.filter((entry) => entry.kind === "detached").length).toBe(1);
  for (const { rect } of rects) {
    expect(rect.width).toBeGreaterThanOrEqual(2);
    expect(rect.height).toBeGreaterThanOrEqual(2);
    expect(rect.x + rect.width).toBeLessThanOrEqual(bounds.width);
    expect(rect.y + rect.height).toBeLessThanOrEqual(bounds.height);
  }
});

test("draws the schematic with real bordered boxes", async () => {
  testSetup = await testRender(
    <CommandBarLayoutPreview contentPadding={3} height={LAYOUT_PREVIEW_ROWS} layout={layout} width={40} />,
    { width: 50, height: LAYOUT_PREVIEW_ROWS + 1 },
  );
  await testSetup.renderOnce();

  const frame = testSetup.captureCharFrame();
  expect(frame).toMatch(/[┌└┐┘]/);
  expect(frame.split("\n").filter((line) => /[┌└┐┘│─]/.test(line)).length).toBeGreaterThan(2);
});
