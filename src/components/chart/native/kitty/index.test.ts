import { describe, expect, test } from "bun:test";
import type { CliRenderer } from "@opentui/core";
import { buildChartScene, resolveChartPalette } from "../../core/renderer";
import {
  computeBitmapSize,
  computeNativePlacement,
  excludeCellRects,
  renderNativeChartBase,
  renderCrosshairStrips,
  type CellRect,
} from "../chart-rasterizer";
import { KittyImageManager } from "./manager";
import { chunkBase64Payload, encodeKittyTransmitRgba } from "./protocol";
import {
  ensureKittySupport,
  getCachedKittySupport,
  resolveKittySupport,
} from "./support";
import { resolveChartRendererState } from "../renderer-selection";
import { computeSurfaceVisibleFragments, NativeSurfaceManager } from "../surface/manager";
import { syncCachedNativeSurface } from "../surface/sync";
import { resolveNativeSurfaceVisibleRect, type NativeSurfaceRenderableNode } from "../surface/visibility";

describe("resolveChartRendererState", () => {
  test("resolves auto and forced kitty correctly", () => {
    expect(resolveChartRendererState("auto", true, { width: 1200, height: 800 })).toMatchObject({
      renderer: "kitty",
      nativeReady: true,
      nativeUnavailable: false,
    });
    expect(resolveChartRendererState("auto", false, { width: 1200, height: 800 })).toMatchObject({
      renderer: "braille",
      nativeReady: false,
      nativeUnavailable: false,
    });
    expect(resolveChartRendererState("kitty", false, null)).toMatchObject({
      renderer: "braille",
      nativeReady: false,
      nativeUnavailable: true,
    });
    expect(resolveChartRendererState("braille", true, { width: 1200, height: 800 })).toMatchObject({
      renderer: "braille",
      nativeReady: true,
      nativeUnavailable: false,
    });
  });
});

describe("resolveKittySupport", () => {
  const noMultiplexer = { TERM: "xterm-kitty" } as Record<string, string | undefined>;

  test("never claims support behind a multiplexer, whatever it advertises", () => {
    expect(resolveKittySupport({ kitty_graphics: true, multiplexer: "tmux" }, noMultiplexer)).toBe(false);
    expect(resolveKittySupport({ kitty_graphics: true }, { TERM: "tmux-256color" })).toBe(false);
    expect(resolveKittySupport({ kitty_graphics: true }, { TERM_PROGRAM: "tmux" })).toBe(false);
    expect(resolveKittySupport({ kitty_graphics: true }, { TMUX: "/tmp/tmux-501/default,1,0" })).toBe(false);
  });

  test("keeps confirmed support and leaves an unanswered query undecided", () => {
    expect(resolveKittySupport({ kitty_graphics: true, multiplexer: "none" }, noMultiplexer)).toBe(true);
    expect(resolveKittySupport({ kitty_graphics: false }, noMultiplexer)).toBe(false);
    expect(resolveKittySupport({}, noMultiplexer)).toBe(null);
    expect(resolveKittySupport(null, noMultiplexer)).toBe(null);
  });
});

describe("getCachedKittySupport", () => {
  test("prefers later renderer capabilities over a failed query cache", async () => {
    let capabilities: { kitty_graphics?: boolean; multiplexer?: string } | null = null;
    const renderer = {
      isDestroyed: false,
      get capabilities() {
        return capabilities;
      },
      on() {},
      off() {},
      write() {
        return false;
      },
    } as unknown as CliRenderer;

    expect(await ensureKittySupport(renderer)).toBe(false);
    expect(getCachedKittySupport(renderer)).toBe(false);

    capabilities = { kitty_graphics: true, multiplexer: "none" };
    expect(getCachedKittySupport(renderer)).toBe(true);
  });
});

describe("encodeKittyTransmitRgba", () => {
  test("chunks compressed rgba uploads and keeps metadata on the first chunk", () => {
    const rgba = new Uint8Array(64).fill(255);
    const sequences = encodeKittyTransmitRgba({
      imageId: 41,
      width: 4,
      height: 4,
      rgba,
      chunkSize: 8,
    });

    expect(sequences.length).toBeGreaterThan(1);
    expect(sequences[0]).toContain("a=t");
    expect(sequences[0]).toContain("f=32");
    expect(sequences[0]).toContain("o=z");
    expect(sequences[0]).toContain("i=41");
    expect(sequences[0]).toContain("s=4");
    expect(sequences[0]).toContain("v=4");
    expect(sequences[0]).toContain("m=1");
    expect(sequences[1]).not.toContain("a=t");
    expect(sequences[sequences.length - 1]).toContain("m=0");
  });

  test("splits base64 payloads deterministically", () => {
    expect(chunkBase64Payload("abcdefghijkl", 5)).toEqual(["abcde", "fghij", "kl"]);
  });
});

describe("computeNativePlacement", () => {
  test("maps clipped cell rectangles back into source pixel crops", () => {
    const fullRect: CellRect = { x: 5, y: 4, width: 10, height: 6 };
    const visibleRect: CellRect = { x: 8, y: 6, width: 4, height: 3 };
    const bitmapSize = computeBitmapSize(fullRect, { width: 1000, height: 600 }, 100, 30);
    const placement = computeNativePlacement(
      fullRect,
      visibleRect,
      { width: bitmapSize.pixelWidth, height: bitmapSize.pixelHeight, pixels: new Uint8Array(0) },
      { width: 1000, height: 600 },
      100,
      30,
    );

    expect(placement).toEqual({
      column: 9,
      row: 7,
      cols: 4,
      rows: 3,
      cropX: 30,
      cropY: 40,
      cropWidth: 40,
      cropHeight: 60,
    });
  });
});

describe("resolveNativeSurfaceVisibleRect", () => {
  test("treats hidden ancestors as invisible for native graphics", () => {
    const hiddenParent: NativeSurfaceRenderableNode = {
      x: 0,
      y: 0,
      width: 80,
      height: 20,
      visible: false,
      parent: null,
    };
    const child: NativeSurfaceRenderableNode = {
      x: 2,
      y: 3,
      width: 20,
      height: 8,
      parent: hiddenParent,
    };

    expect(resolveNativeSurfaceVisibleRect(child, 100, 30)).toBeNull();
  });

  test("stops at repeated ancestors in cyclic native renderable trees", () => {
    const root: NativeSurfaceRenderableNode = {
      x: 0,
      y: 0,
      width: 100,
      height: 30,
      parent: null,
    };
    const child: NativeSurfaceRenderableNode = {
      x: 2,
      y: 3,
      width: 20,
      height: 8,
      parent: root,
    };
    root.parent = child;

    expect(resolveNativeSurfaceVisibleRect(child, 100, 30)).toEqual({
      x: 2,
      y: 3,
      width: 20,
      height: 8,
    });
  });

  test("fails closed when native renderable ancestors exceed a sane depth", () => {
    let node: NativeSurfaceRenderableNode = {
      x: 0,
      y: 0,
      width: 100,
      height: 30,
      parent: null,
    };

    for (let index = 0; index < 300; index += 1) {
      node = {
        x: 0,
        y: 0,
        width: 100,
        height: 30,
        parent: node,
      };
    }

    expect(resolveNativeSurfaceVisibleRect(node, 100, 30)).toBeNull();
  });
});

describe("renderNativeChartBase", () => {
  test("leaves untouched bitmap pixels transparent", () => {
    const palette = resolveChartPalette({
      bg: "#112233",
      border: "#333333",
      borderFocused: "#ffff00",
      text: "#ffffff",
      textDim: "#777777",
      positive: "#00ff00",
      negative: "#ff0000",
    }, "positive");
    const scene = buildChartScene([
      { date: new Date("2024-01-02"), open: 10, high: 12, low: 9, close: 11, volume: 100 },
      { date: new Date("2024-01-03"), open: 11, high: 13, low: 10, close: 12, volume: 120 },
    ], {
      width: 12,
      height: 6,
      showVolume: false,
      volumeHeight: 0,
      cursorX: null,
      cursorY: null,
      mode: "line",
      colors: palette,
    });

    expect(scene).not.toBeNull();

    const bitmap = renderNativeChartBase(scene!, 24, 12);
    let transparentPixels = 0;
    let drawnPixels = 0;
    for (let offset = 3; offset < bitmap.pixels.length; offset += 4) {
      if (bitmap.pixels[offset] === 0) {
        transparentPixels += 1;
      } else {
        drawnPixels += 1;
      }
    }
    expect(transparentPixels).toBeGreaterThan(0);
    expect(drawnPixels).toBeGreaterThan(0);
  });

  test("keeps solid candle bodies opaque over the wick", () => {
    const palette = resolveChartPalette({
      bg: "#112233",
      border: "#333333",
      borderFocused: "#ffff00",
      text: "#ffffff",
      textDim: "#777777",
      positive: "#00ff00",
      negative: "#ff0000",
    }, "negative");
    const scene = buildChartScene([
      { date: new Date("2024-01-02"), open: 12, high: 14, low: 8, close: 9, volume: 100 },
      { date: new Date("2024-01-03"), open: 9, high: 10, low: 7, close: 8.5, volume: 120 },
    ], {
      width: 20,
      height: 12,
      showVolume: false,
      volumeHeight: 0,
      cursorX: null,
      cursorY: null,
      mode: "candles",
      colors: palette,
    });

    expect(scene).not.toBeNull();

    const bitmap = renderNativeChartBase(scene!, 80, 48);
    const bodyCenterOffset = (24 * bitmap.width + 20) * 4;
    expect([...bitmap.pixels.slice(bodyCenterOffset, bodyCenterOffset + 4)]).toEqual([255, 0, 0, 255]);
  });

  test("ignores cursor state when rendering the base bitmap", () => {
    const palette = resolveChartPalette({
      bg: "#112233",
      border: "#333333",
      borderFocused: "#ffff00",
      text: "#ffffff",
      textDim: "#777777",
      positive: "#00ff00",
      negative: "#ff0000",
    }, "positive");
    const scene = buildChartScene([
      { date: new Date("2024-01-02"), open: 10, high: 10, low: 10, close: 10, volume: 100 },
      { date: new Date("2024-01-03"), open: 10, high: 10, low: 10, close: 10, volume: 120 },
    ], {
      width: 12,
      height: 6,
      showVolume: false,
      volumeHeight: 0,
      cursorX: null,
      cursorY: null,
      mode: "line",
      colors: palette,
    });
    const sceneWithCursor = buildChartScene([
      { date: new Date("2024-01-02"), open: 10, high: 10, low: 10, close: 10, volume: 100 },
      { date: new Date("2024-01-03"), open: 10, high: 10, low: 10, close: 10, volume: 120 },
    ], {
      width: 12,
      height: 6,
      showVolume: false,
      volumeHeight: 0,
      cursorX: 4.5,
      cursorY: 2.5,
      mode: "line",
      colors: palette,
    });

    expect(scene).not.toBeNull();
    expect(sceneWithCursor).not.toBeNull();

    const withoutCursor = renderNativeChartBase(scene!, 120, 60);
    const withCursor = renderNativeChartBase(sceneWithCursor!, 120, 60);
    expect(withCursor.pixels).toEqual(withoutCursor.pixels);
  });

  test("renders indicator overlays into the native chart bitmap", () => {
    const palette = resolveChartPalette({
      bg: "#112233",
      border: "#333333",
      borderFocused: "#ffff00",
      text: "#ffffff",
      textDim: "#777777",
      positive: "#00ff00",
      negative: "#ff0000",
    }, "positive");
    const points = [
      { date: new Date("2024-01-02"), open: 10, high: 12, low: 9, close: 11, volume: 100 },
      { date: new Date("2024-01-03"), open: 11, high: 13, low: 10, close: 12, volume: 120 },
      { date: new Date("2024-01-04"), open: 12, high: 14, low: 11, close: 13, volume: 130 },
    ];
    const baseScene = buildChartScene(points, {
      width: 18,
      height: 8,
      showVolume: false,
      volumeHeight: 0,
      cursorX: null,
      cursorY: null,
      mode: "line",
      colors: palette,
    });
    const sceneWithIndicator = buildChartScene(points, {
      width: 18,
      height: 8,
      showVolume: false,
      volumeHeight: 0,
      cursorX: null,
      cursorY: null,
      mode: "line",
      colors: palette,
      indicators: {
        smaLines: [{
          period: 2,
          color: "#ff00ff",
          points: [
            { index: 0, value: 9.5 },
            { index: 1, value: 10.5 },
            { index: 2, value: 11.5 },
          ],
        }],
        emaLines: [],
        bollinger: null,
        rsi: null,
        macd: null,
      },
    });

    expect(baseScene).not.toBeNull();
    expect(sceneWithIndicator).not.toBeNull();

    const baseBitmap = renderNativeChartBase(baseScene!, 120, 60);
    const indicatorBitmap = renderNativeChartBase(sceneWithIndicator!, 120, 60);
    expect(indicatorBitmap.pixels).not.toEqual(baseBitmap.pixels);

    let magentaPixels = 0;
    for (let offset = 0; offset < indicatorBitmap.pixels.length; offset += 4) {
      const red = indicatorBitmap.pixels[offset]!;
      const green = indicatorBitmap.pixels[offset + 1]!;
      const blue = indicatorBitmap.pixels[offset + 2]!;
      if (red > 180 && blue > 180 && green < 120) magentaPixels += 1;
    }
    expect(magentaPixels).toBeGreaterThan(0);
  });
});

describe("renderCrosshairStrips", () => {
  const strips = renderCrosshairStrips({
    pixelX: 49.5,
    pixelY: 30.25,
    pixelWidth: 120,
    pixelHeight: 60,
    cols: 12,
    rows: 6,
    cellWidth: 10,
    cellHeight: 10,
    color: "#ffffff",
    markers: [{ pixelY: 12, color: "#ff00ff" }],
  });

  test("places thin strips on the cursor's cells with sub-cell line positions", () => {
    const [vertical, horizontal] = strips;
    // Cursor sits in column 4 and row 3; the vertical strip is padded by a cell.
    expect(vertical!.rect).toEqual({ x: 3, y: 0, width: 3, height: 6 });
    expect(horizontal!.rect).toEqual({ x: 0, y: 3, width: 12, height: 1 });
    expect(vertical!.bitmap.width).toBe(30);
    expect(vertical!.bitmap.height).toBe(60);
    expect(horizontal!.bitmap.width).toBe(120);
    expect(horizontal!.bitmap.height).toBe(10);

    // Line pixels land at the cursor offset inside the strip, not at its edge.
    const verticalOffset = (10 * vertical!.bitmap.width + 19) * 4;
    expect(vertical!.bitmap.pixels[verticalOffset + 3]).toBeGreaterThan(0);
    const horizontalOffset = (0 * horizontal!.bitmap.width + 60) * 4;
    expect(horizontal!.bitmap.pixels[horizontalOffset + 3]).toBeGreaterThan(0);
  });

  test("draws series markers and stays transparent away from the cursor", () => {
    const vertical = strips[0]!;
    const markerOffset = (12 * vertical.bitmap.width + 19) * 4;
    expect(vertical.bitmap.pixels[markerOffset]).toBeGreaterThan(180);
    expect(vertical.bitmap.pixels[markerOffset + 2]).toBeGreaterThan(180);
    expect(vertical.bitmap.pixels[(40 * vertical.bitmap.width + 1) * 4 + 3]).toBe(0);
  });
});

describe("excludeCellRects", () => {
  test("splits a surface into remaining visible fragments", () => {
    expect(excludeCellRects(
      { x: 10, y: 6, width: 12, height: 8 },
      [{ x: 14, y: 8, width: 3, height: 2 }],
    )).toEqual([
      { x: 10, y: 6, width: 12, height: 2 },
      { x: 10, y: 10, width: 12, height: 4 },
      { x: 10, y: 8, width: 4, height: 2 },
      { x: 17, y: 8, width: 5, height: 2 },
    ]);
  });
});

describe("computeSurfaceVisibleFragments", () => {
  test("subtracts overlapping higher-layer occluders", () => {
    expect(computeSurfaceVisibleFragments(
      { x: 10, y: 6, width: 12, height: 8 },
      { x: 10, y: 6, width: 12, height: 8 },
      0,
      "ticker-detail:main",
      [{
        id: "console:main",
        paneId: "console:main",
        rect: { x: 14, y: 8, width: 3, height: 2 },
        zIndex: 90,
      }],
    )).toEqual([
      { x: 10, y: 6, width: 12, height: 2 },
      { x: 10, y: 8, width: 4, height: 2 },
      { x: 17, y: 8, width: 5, height: 2 },
      { x: 10, y: 10, width: 12, height: 4 },
    ]);
  });

  test("ignores occluders from lower layers or the same pane", () => {
    expect(computeSurfaceVisibleFragments(
      { x: 10, y: 6, width: 12, height: 8 },
      { x: 10, y: 6, width: 12, height: 8 },
      120,
      "chart:float",
      [
        {
          id: "chart:float",
          paneId: "chart:float",
          rect: { x: 12, y: 8, width: 4, height: 2 },
          zIndex: 120,
        },
        {
          id: "console:main",
          paneId: "console:main",
          rect: { x: 14, y: 8, width: 3, height: 2 },
          zIndex: 80,
        },
      ],
    )).toEqual([
      { x: 10, y: 6, width: 12, height: 8 },
    ]);
  });

  test("subtracts an explicitly local overlay from its own pane", () => {
    expect(computeSurfaceVisibleFragments(
      { x: 10, y: 6, width: 12, height: 8 },
      { x: 10, y: 6, width: 12, height: 8 },
      120,
      "chart:float",
      [{
        id: "chart:float:quick-add",
        paneId: "chart:float",
        rect: { x: 14, y: 6, width: 4, height: 3 },
        zIndex: 120,
        occludesOwnPane: true,
      }],
    )).toEqual([
      { x: 10, y: 6, width: 4, height: 3 },
      { x: 18, y: 6, width: 4, height: 3 },
      { x: 10, y: 9, width: 12, height: 5 },
    ]);
  });
});

describe("KittyImageManager", () => {
  test("reuses placement ids across multiple fragments and deletes the previous image on swap", () => {
    const writes: string[] = [];
    const renderer = {
      write(payload: string | Uint8Array) {
        writes.push(typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8"));
        return true;
      },
    } as unknown as CliRenderer;

    const manager = new KittyImageManager(renderer);
    const placements = [
      {
        column: 2,
        row: 3,
        cols: 4,
        rows: 2,
        cropX: 0,
        cropY: 0,
        cropWidth: 40,
        cropHeight: 20,
      },
      {
        column: 8,
        row: 3,
        cols: 2,
        rows: 2,
        cropX: 60,
        cropY: 0,
        cropWidth: 20,
        cropHeight: 20,
      },
    ];

    manager.render({ width: 40, height: 20, pixels: new Uint8Array(40 * 20 * 4) }, placements, "first");
    manager.render({ width: 40, height: 20, pixels: new Uint8Array(40 * 20 * 4).fill(1) }, placements, "second");

    const firstWrite = writes[0]!;
    const secondWrite = writes[1]!;
    const firstImageId = firstWrite.match(/i=(\d+)/)?.[1];
    const secondImageId = secondWrite.match(/i=(\d+)/)?.[1];
    const firstPlacementIds = [...firstWrite.matchAll(/p=(\d+)/g)].map((match) => match[1]);
    const secondPlacementIds = [...secondWrite.matchAll(/p=(\d+)/g)].map((match) => match[1]);

    expect(firstImageId).toBeTruthy();
    expect(secondImageId).toBeTruthy();
    expect(secondImageId).not.toBe(firstImageId);
    expect(firstPlacementIds.length).toBeGreaterThanOrEqual(2);
    expect(secondPlacementIds.slice(0, 2)).toEqual(firstPlacementIds.slice(0, 2));
    expect(secondWrite).toContain(`a=d,d=I,i=${firstImageId!}`);
  });
});

describe("NativeSurfaceManager", () => {
  test("recreates a cached surface when geometry becomes visible later", () => {
    const bitmap = { width: 200, height: 80, pixels: new Uint8Array(200 * 80 * 4) };
    const upsertCalls: Array<{
      id: string;
      paneId: string;
      rect: CellRect;
      visibleRect: CellRect | null;
      bitmap: typeof bitmap;
      bitmapKey: string;
    }> = [];
    const geometryCalls: Array<{
      id: string;
      paneId: string;
      rect: CellRect;
      visibleRect: CellRect | null;
    }> = [];

    const manager = {
      upsertSurface(snapshot: {
        id: string;
        paneId: string;
        rect: CellRect;
        visibleRect: CellRect | null;
        bitmap: typeof bitmap;
        bitmapKey: string;
      }) {
        upsertCalls.push(snapshot);
      },
      updateSurfaceGeometry(id: string, geometry: {
        paneId: string;
        rect: CellRect;
        visibleRect: CellRect | null;
      }) {
        geometryCalls.push({ id, ...geometry });
      },
    };

    syncCachedNativeSurface(
      manager,
      "chart",
      {
        paneId: "pane",
        rect: { x: 2, y: 3, width: 20, height: 8 },
        visibleRect: null,
      },
      { key: "frame-1", bitmap },
    );
    syncCachedNativeSurface(
      manager,
      "chart",
      {
        paneId: "pane",
        rect: { x: 2, y: 3, width: 20, height: 8 },
        visibleRect: { x: 2, y: 3, width: 20, height: 8 },
      },
      { key: "frame-1", bitmap },
    );

    expect(geometryCalls).toEqual([{
      id: "chart",
      paneId: "pane",
      rect: { x: 2, y: 3, width: 20, height: 8 },
      visibleRect: null,
    }]);
    expect(upsertCalls).toEqual([{
      id: "chart",
      paneId: "pane",
      rect: { x: 2, y: 3, width: 20, height: 8 },
      visibleRect: { x: 2, y: 3, width: 20, height: 8 },
      bitmap,
      bitmapKey: "frame-1",
    }]);
  });

  test("skips geometry sync work when the surface rect is unchanged", () => {
    const writes: string[] = [];
    const renderer = {
      resolution: { width: 1200, height: 800 },
      terminalWidth: 120,
      terminalHeight: 40,
      write(payload: string | Uint8Array) {
        writes.push(typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8"));
        return true;
      },
    } as unknown as CliRenderer;

    const manager = new NativeSurfaceManager(renderer);
    manager.upsertSurface({
      id: "chart",
      paneId: "pane",
      rect: { x: 2, y: 3, width: 20, height: 8 },
      visibleRect: { x: 2, y: 3, width: 20, height: 8 },
      bitmap: { width: 200, height: 80, pixels: new Uint8Array(200 * 80 * 4) },
      bitmapKey: "frame-1",
    });

    expect(writes.length).toBe(1);

    manager.updateSurfaceGeometry("chart", {
      paneId: "pane",
      rect: { x: 2, y: 3, width: 20, height: 8 },
      visibleRect: { x: 2, y: 3, width: 20, height: 8 },
    });

    expect(writes.length).toBe(1);
  });

  test("clips and restores a surface as a local overlay opens and closes", () => {
    const renderer = {
      resolution: { width: 1200, height: 800 },
      terminalWidth: 120,
      terminalHeight: 40,
      write() { return true; },
    } as unknown as CliRenderer;
    const manager = new NativeSurfaceManager(renderer);
    const originalRender = KittyImageManager.prototype.render;
    const renderedRowCounts: number[][] = [];
    KittyImageManager.prototype.render = function(
      _bitmap,
      placement,
    ) {
      const placements = Array.isArray(placement) ? placement : [placement];
      renderedRowCounts.push(placements.map((entry) => entry.rows));
    };

    try {
      manager.setWindowState({
        paneLayers: [{ paneId: "pane", zIndex: 120 }],
        occluders: [],
      });
      manager.upsertSurface({
        id: "chart",
        paneId: "pane",
        rect: { x: 2, y: 3, width: 20, height: 8 },
        visibleRect: { x: 2, y: 3, width: 20, height: 8 },
        bitmap: { width: 200, height: 80, pixels: new Uint8Array(200 * 80 * 4) },
        bitmapKey: "frame-1",
      });
      manager.upsertLocalOccluder({
        id: "quick-add",
        paneId: "pane",
        rect: { x: 2, y: 3, width: 20, height: 2 },
      });
      manager.removeLocalOccluder("quick-add");

      expect(renderedRowCounts).toEqual([[8], [6], [8]]);
    } finally {
      KittyImageManager.prototype.render = originalRender;
      manager.destroy();
    }
  });

  test("skips rerendering when an identical surface snapshot is upserted", () => {
    const renderer = {
      resolution: { width: 1200, height: 800 },
      terminalWidth: 120,
      terminalHeight: 40,
      write() { return true; },
    } as unknown as CliRenderer;
    const manager = new NativeSurfaceManager(renderer);
    const originalRender = KittyImageManager.prototype.render;
    let renderCalls = 0;
    KittyImageManager.prototype.render = function(...args: Parameters<KittyImageManager["render"]>) {
      renderCalls += 1;
      return originalRender.apply(this, args);
    };

    try {
      manager.upsertSurface({
        id: "chart",
        paneId: "pane",
        rect: { x: 2, y: 3, width: 20, height: 8 },
        visibleRect: { x: 2, y: 3, width: 20, height: 8 },
        bitmap: { width: 200, height: 80, pixels: new Uint8Array(200 * 80 * 4) },
        bitmapKey: "frame-1",
      });
      manager.upsertSurface({
        id: "chart",
        paneId: "pane",
        rect: { x: 2, y: 3, width: 20, height: 8 },
        visibleRect: { x: 2, y: 3, width: 20, height: 8 },
        bitmap: { width: 200, height: 80, pixels: new Uint8Array(200 * 80 * 4).fill(1) },
        bitmapKey: "frame-1",
      });

      expect(renderCalls).toBe(1);
    } finally {
      KittyImageManager.prototype.render = originalRender;
      manager.destroy();
    }
  });

  test("skips syncing all surfaces when the native window state is unchanged", () => {
    const renderer = {
      resolution: { width: 1200, height: 800 },
      terminalWidth: 120,
      terminalHeight: 40,
      write() { return true; },
    } as unknown as CliRenderer;
    const manager = new NativeSurfaceManager(renderer);
    const originalRender = KittyImageManager.prototype.render;
    let renderCalls = 0;
    KittyImageManager.prototype.render = function(...args: Parameters<KittyImageManager["render"]>) {
      renderCalls += 1;
      return originalRender.apply(this, args);
    };

    try {
      manager.upsertSurface({
        id: "chart",
        paneId: "pane",
        rect: { x: 2, y: 3, width: 20, height: 8 },
        visibleRect: { x: 2, y: 3, width: 20, height: 8 },
        bitmap: { width: 200, height: 80, pixels: new Uint8Array(200 * 80 * 4) },
        bitmapKey: "frame-1",
      });
      manager.setWindowState({ paneLayers: [], occluders: [] });
      manager.setWindowState({ paneLayers: [], occluders: [] });

      expect(renderCalls).toBe(1);
    } finally {
      KittyImageManager.prototype.render = originalRender;
      manager.destroy();
    }
  });
});
