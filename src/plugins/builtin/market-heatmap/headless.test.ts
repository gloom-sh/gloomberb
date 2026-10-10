import { describe, expect, test } from "bun:test";
import type { MarketHeatmapAsset } from "../../../api-client/market-discovery";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/headless";
import { marketHeatmapHeadless } from "./headless";

function asset(symbol: string, size: number, changePercent: number | null, sector = "Tech"): MarketHeatmapAsset {
  return {
    symbol, name: symbol, price: 10, change: 0, changePercent: changePercent ?? 0, hasChange: changePercent != null,
    size, sizeKind: "market-cap", volume: null, currency: "USD", exchange: "NYSE", sector, industry: null, marketState: null, source: "gloom",
  };
}

function board(withoutMove: number, total: number): MarketHeatmapAsset[] {
  return Array.from({ length: total }, (_, index) => asset(
    `S${index}`, 100 + index, index < withoutMove ? null : 1, index % 2 === 0 ? "Tech" : "Energy",
  ));
}

async function load(assets: MarketHeatmapAsset[], stale = false) {
  const apiClient = {
    getMarketHeatmap: async () => ({ status: "success", stale, data: { universe: "us-equity", source: "gloom", fetchedAt: Date.UTC(2026, 9, 9, 12), assets } }),
  };
  const args = { symbols: [], argument: [], rawArgument: "", options: { universe: "us-equity", group: "sector" } } as HeadlessPaneLoadArgs;
  return marketHeatmapHeadless.load(args, { signal: new AbortController().signal, apiClient, refresh: false } as unknown as HeadlessPaneContext);
}

describe("fn HM report", () => {
  test("a few names without a move stay in a notice and the report is still complete", async () => {
    const result = await load(board(2, 40));
    expect(result.complete).toBe(true);
    expect(result.unavailableSymbols).toEqual([]);
    expect(result.metadata?.noMove).toEqual(["S0", "S1"]);
    expect(result.metadata?.notices).toEqual(["2 of 40 names have no move yet and count toward size only: S0, S1."]);
    expect(result.rows.map((row) => row.names)).toEqual([20, 20]);
  });

  test("a board where most names lack a move is incomplete and names them", async () => {
    const result = await load(board(30, 40));
    expect(result.complete).toBe(false);
    expect(result.unavailableSymbols).toHaveLength(30);
  });

  test("a stale snapshot is incomplete and says so", async () => {
    const result = await load(board(0, 40), true);
    expect(result.complete).toBe(false);
    expect(result.metadata).toMatchObject({ stale: true, noMove: [] });
    expect(result.metadata?.notices).toBeUndefined();
  });
});
