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
      .toBe("Source: Gloom Cloud · US trading day Fri 9 Oct 2026 close · delayed · markets closed · regular session opens Mon 13:30 UTC, 09:30 ET");
    // An older server names the session without its close: the trading day still dates it.
    const undated = await load(board(0, 40), false, { fetchedAt: SUN - 60_000, regularSessionDate: "2026-10-09" });
    expect(formatFreshnessLine(deriveHeadlessFreshness(marketHeatmapHeadless, undated, SUN)))
      .toBe("Source: Gloom Cloud · US trading day Fri 9 Oct 2026 · delayed · markets closed · regular session opens Mon 13:30 UTC, 09:30 ET");
    // While the session trades, the snapshot is as of when it was put together.
    const MON = Date.UTC(2026, 9, 12, 15, 42);
    const trading = await load(board(0, 40), false, { fetchedAt: MON - 60_000, session: "REGULAR", regularSessionDate: null });
    expect(formatFreshnessLine(deriveHeadlessFreshness(marketHeatmapHeadless, trading, MON)))
      .toBe("Source: Gloom Cloud · Mon 12 Oct 2026 15:41 UTC · delayed · markets open");
    // A server that dates its prices: as of the oldest print, not the snapshot.
    const printed = await load(board(0, 40), false, { fetchedAt: MON - 60_000, session: "REGULAR", regularSessionDate: null, pricesAsOf: MON - 22 * 60_000 });
    expect(printed.metadata?.asOf).toBe("2026-10-12T15:20:00.000Z");
  });

  test("a Pro account's board reads as live, everyone else's as delayed", async () => {
    const MON = Date.UTC(2026, 9, 12, 15, 42);
    const live = await load(board(0, 40), false, { fetchedAt: MON - 10_000, session: "REGULAR", access: "realtime" });
    expect(formatFreshnessLine(deriveHeadlessFreshness(marketHeatmapHeadless, live, MON))).toContain("· live ·");
    for (const access of ["delayed", undefined] as const) {
      const delayed = await load(board(0, 40), false, { fetchedAt: MON - 10_000, session: "REGULAR", access });
      expect(formatFreshnessLine(deriveHeadlessFreshness(marketHeatmapHeadless, delayed, MON))).toContain("· delayed ·");
    }
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

  test("a Pro board's names without a live price are left out of the moves and listed with their delayed print", async () => {
    const MON = Date.UTC(2026, 10, 23, 16, 46);
    const printedAt = Date.UTC(2026, 10, 23, 16, 21);
    // As the server sends it: no move and no price, as older apps draw a blank tile, and the delayed figures beside it.
    const delayed: MarketHeatmapAsset = { ...asset("S0", 100, null), price: 0, volume: null, regularChangePercent: null,
      delayedQuote: { price: 151.33, changePercent: -1.4, volume: 900, printedAt } };
    const assets = [delayed, ...board(1, 40).slice(1)];
    const result = await load(assets, false, { fetchedAt: MON - 5_000, session: "REGULAR", access: "realtime", pricesAsOf: MON - 5_000 });
    expect(result.complete).toBe(true);
    expect(result.metadata?.noMove).toEqual([]);
    expect(result.metadata?.delayed).toEqual([{ symbol: "S0", move: -1.4, price: 151.33, printedAt: "2026-11-23T16:21:00.000Z" }]);
    expect((result.metadata?.notices as string[])[0]).toMatch(/^1 of 40 names had no live price and are left out of the moves; their delayed figures are in metadata\.delayed: S0 delayed (23 Nov )?11:21 ET\.$/);
    // Its delayed move counts in no group.
    expect(result.rows.map((row) => [row.group, row.names, row.moved])).toEqual([["Energy", 20, 20], ["Tech", 20, 19]]);
    expect(result.metadata?.asOf).toBe(new Date(MON - 5_000).toISOString());
  });

  test("a Pro board in the session reads live only while it has live moves and is current", async () => {
    const MON = Date.UTC(2026, 10, 23, 16, 46);
    const line = (result: Awaited<ReturnType<typeof load>>, now = MON) => formatFreshnessLine(deriveHeadlessFreshness(marketHeatmapHeadless, result, now));
    // A name the live read did not price, as the server sends it.
    const unpriced = (symbol: string): MarketHeatmapAsset => ({ ...asset(symbol, 100, null), price: 0, volume: null, regularChangePercent: null,
      delayedQuote: { price: 151.33, changePercent: -1.4, volume: 900, printedAt: MON - 25 * 60_000 } });
    const inSession = { fetchedAt: MON - 5_000, pricesAsOf: MON - 5_000, session: "REGULAR" as const, access: "realtime" as const };
    // Live moves with a few names beside their tiles: live, as before.
    const mixed = await load([unpriced("S0"), ...board(0, 40).slice(1)], false, inSession);
    expect(mixed.freshness?.status).toBe("live");
    expect(line(mixed)).toContain("· live ·");
    // The server says the board is stale (its live read is old): stale, not live.
    const stale = await load(board(0, 40), true, { ...inSession, fetchedAt: MON - 60_000, pricesAsOf: MON - 60_000 });
    expect(stale.freshness?.status).toBe("stale");
    expect(line(stale)).toContain("· stale (1 min old) ·");
    expect(line(stale)).not.toContain("live");
    // No live read yet, or nothing traded since the open: every figure is a delayed one beside its tile.
    const names = Array.from({ length: 40 }, (_, index) => unpriced(`S${index}`));
    const unread = await load(names, true, { ...inSession, fetchedAt: MON - 10 * 60_000, pricesAsOf: null });
    expect(unread.freshness?.status).toBe("stale");
    expect(line(unread)).not.toContain("live");
    const untraded = await load(names, false, { ...inSession, fetchedAt: MON - 10 * 60_000, pricesAsOf: null });
    expect(untraded.freshness?.status).toBe("delayed");
    expect(line(untraded)).toContain("· delayed ·");
    expect(untraded.metadata?.delayed).toHaveLength(40);
    // Outside the session a Pro board reads as it did.
    const SAT = Date.UTC(2026, 10, 21, 15);
    const closed = await load(board(0, 40), false, { fetchedAt: SAT - 60_000, session: "CLOSED", access: "realtime",
      regularSessionDate: "2026-11-20", regularSessionClosedAt: Date.UTC(2026, 10, 20, 21) });
    expect(closed.freshness?.status).toBe("live");
    expect(line(closed, SAT)).toContain("· live ·");
  });

  test("a stale snapshot is incomplete and says so", async () => {
    const result = await load(board(0, 40), true);
    expect(result.complete).toBe(false);
    expect(result.metadata).toMatchObject({ stale: true, noMove: [] });
    expect(result.metadata?.notices).toBeUndefined();
  });
});
