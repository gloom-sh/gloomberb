import { expect, test } from "bun:test";
import { cloneLayout, createDefaultConfig } from "../types/config";
import { buildLayoutPreviewRects } from "./geometry";

const layout = (() => {
  const next = cloneLayout(createDefaultConfig("/tmp/gloomberb-test").layout);
  next.floating = [{ instanceId: "chat:main", x: 40, y: 6, width: 30, height: 10 }];
  next.detached = [{ instanceId: "quote-monitor:main", x: 70, y: 2, width: 24, height: 8 }];
  return next;
})();

test("maps docked, floating, and detached panes into in-bounds preview rects", () => {
  const bounds = { width: 40, height: 7 };
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

test("keeps pixel previews fractional and layered above docked panes", () => {
  const bounds = { width: 320, height: 180 };
  const rects = buildLayoutPreviewRects(layout, bounds, { width: 120, height: 40 }, {
    minSize: 10,
    fractional: true,
  });

  const docked = rects.filter((entry) => entry.kind === "docked");
  const floating = rects.find((entry) => entry.kind === "floating")!;
  const detached = rects.find((entry) => entry.kind === "detached")!;
  expect(floating.depth).toBeGreaterThan(docked[0]!.depth);
  expect(detached.depth).toBeGreaterThan(floating.depth);
  expect(floating.instanceId).toBe("chat:main");
  // 40/120 of a 320px card, kept fractional instead of snapped to whole cells.
  expect(floating.rect.x).toBeCloseTo(106.67, 1);
  for (const { rect } of rects) {
    expect(rect.width).toBeGreaterThanOrEqual(10);
    expect(rect.x + rect.width).toBeLessThanOrEqual(bounds.width + 0.001);
    expect(rect.y + rect.height).toBeLessThanOrEqual(bounds.height + 0.001);
  }
});
