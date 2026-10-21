import { describe, expect, test } from "bun:test";
import type { MarketHeatmapAsset, MarketHeatmapResult } from "../../../api-client/market-discovery";
import { deriveHeadlessFreshness, formatFreshnessLine } from "../../../cli/pane-functions/freshness";
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

async function load(assets: MarketHeatmapAsset[], stale = false, session: Partial<MarketHeatmapResult> = {}) {
  const apiClient = {
    getMarketHeatmap: async () => ({ status: "success", stale, data: { universe: "us-equity", source: "gloom", fetchedAt: Date.UTC(2026, 9, 9, 12), assets, ...session } }),
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

  test("a completed session's board is dated by its close, not when the snapshot was put together", async () => {
    const SUN = Date.UTC(2026, 9, 11, 6, 35);
    const closed = await load(board(0, 40), false, {
      fetchedAt: SUN - 60_000, session: "CLOSED", regularSessionDate: "2026-10-09", regularSessionClosedAt: Date.UTC(2026, 9, 9, 20),
    });
    expect(formatFreshnessLine(deriveHeadlessFreshness(marketHeatmapHeadless, closed, SUN)))
      .toBe("Source: Gloom Cloud · US trading day Fri 9 Oct 2026 close · delayed · markets closed until Mon");
    // An older server names the session without its close: the trading day still dates it.
    const undated = await load(board(0, 40), false, { fetchedAt: SUN - 60_000, regularSessionDate: "2026-10-09" });
    expect(formatFreshnessLine(deriveHeadlessFreshness(marketHeatmapHeadless, undated, SUN)))
      .toBe("Source: Gloom Cloud · US trading day Fri 9 Oct 2026 · delayed · markets closed until Mon");
    // While the session trades, the snapshot is as of when it was put together.
    const MON = Date.UTC(2026, 9, 12, 15, 42);
    const trading = await load(board(0, 40), false, { fetchedAt: MON - 60_000, session: "REGULAR", regularSessionDate: null });
    expect(formatFreshnessLine(deriveHeadlessFreshness(marketHeatmapHeadless, trading, MON)))
      .toBe("Source: Gloom Cloud · Mon 12 Oct 2026 15:41 UTC · delayed · markets open");
    // A server that dates its prices: as of the oldest print, not the snapshot.
    const printed = await load(board(0, 40), false, { fetchedAt: MON - 60_000, session: "REGULAR", regularSessionDate: null, pricesAsOf: MON - 22 * 60_000 });
    expect(printed.metadata?.asOf).toBe("2026-10-12T15:20:00.000Z");
  });

  test("sizes, shares and the weighted move stay market cap, whatever the pane's tiles are sized by", async () => {
    // A megacap that barely moved and a small name that jumped: the map's tiles favour the second, the report does not.
    const result = await load([asset("MEGA", 900, 0.1, "Tech"), asset("JUMP", 100, 9, "Energy")]);
    expect(result.columns?.filter((column) => ["size", "sharePercent", "move"].includes(column.key)).map((column) => column.header))
      .toEqual(["Mkt cap", "Cap share", "Move (cap-wtd)"]);
    expect(result.rows.map((row) => [row.group, row.size, Math.round(row.sharePercent as number)])).toEqual([["Tech", 900, 90], ["Energy", 100, 10]]);
    expect(result.rows[0]!.move).toBeCloseTo(0.1, 10);
    expect(marketHeatmapHeadless.discovery?.limitations?.join(" ")).toContain("not the pane's tile area");
  });

  test("a stale snapshot is incomplete and says so", async () => {
    const result = await load(board(0, 40), true);
    expect(result.complete).toBe(false);
    expect(result.metadata).toMatchObject({ stale: true, noMove: [] });
    expect(result.metadata?.notices).toBeUndefined();
  });
});
