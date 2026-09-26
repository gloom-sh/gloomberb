import { describe, expect, test } from "bun:test";
import { createDefaultConfig, createPaneInstance, type LayoutConfig } from "../../types/config";
import type { TickerRecord } from "../../types/ticker";
import { collectSavedLayoutInstruments } from "./layout-warmup";
import { createTestTicker } from "../../test-support/ticker";

function ticker(symbol: string): TickerRecord {
  return createTestTicker(symbol);
}

function fixedLayout(entries: Array<{ instanceId: string; symbol: string; floating?: boolean }>): LayoutConfig {
  const docked = entries.filter((entry) => !entry.floating);
  return {
    dockRoot: docked.length === 0
      ? null
      : docked.slice(1).reduce<LayoutConfig["dockRoot"]>(
        (node, entry) => ({ kind: "split", axis: "horizontal", ratio: 0.5, first: node!, second: { kind: "pane", instanceId: entry.instanceId } }),
        { kind: "pane", instanceId: docked[0]!.instanceId },
      ),
    instances: entries.map((entry) => createPaneInstance("ticker-detail", {
      instanceId: entry.instanceId,
      binding: { kind: "fixed", symbol: entry.symbol },
    })),
    floating: entries.filter((entry) => entry.floating).map((entry) => ({ instanceId: entry.instanceId, x: 0, y: 0, width: 20, height: 10 })),
    detached: [],
  };
}

describe("collectSavedLayoutInstruments", () => {
  test("resolves the panes of every layout except the active one, deduplicated, docked before floating", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    config.layouts = [
      { name: "Home", layout: config.layout, paneState: {} },
      { name: "Tech", layout: fixedLayout([
        { instanceId: "ticker-detail:a", symbol: "MSFT" },
        { instanceId: "ticker-detail:b", symbol: "NVDA", floating: true },
      ]), paneState: {} },
      { name: "Banks", layout: fixedLayout([
        { instanceId: "ticker-detail:c", symbol: "JPM" },
        { instanceId: "ticker-detail:d", symbol: "MSFT" },
      ]), paneState: {} },
    ];
    config.activeLayoutIndex = 0;
    const tickers = new Map(["MSFT", "NVDA", "JPM"].map((symbol) => [symbol, ticker(symbol)]));

    const instruments = collectSavedLayoutInstruments(config, tickers);
    expect(instruments.map((instrument) => instrument.symbol)).toEqual(["MSFT", "NVDA", "JPM"]);
  });

  test("stops at the limit", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    const symbols = ["A", "B", "C", "D"];
    config.layouts = [
      { name: "Home", layout: config.layout, paneState: {} },
      { name: "Many", layout: fixedLayout(symbols.map((symbol) => ({ instanceId: `ticker-detail:${symbol}`, symbol }))), paneState: {} },
    ];
    config.activeLayoutIndex = 0;
    const tickers = new Map(symbols.map((symbol) => [symbol, ticker(symbol)]));

    expect(collectSavedLayoutInstruments(config, tickers, 2).map((instrument) => instrument.symbol)).toEqual(["A", "B"]);
  });
});
