import { expect, spyOn, test } from "bun:test";
import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { PerpMarketPayload } from "../../../api-client/perps";
import { cachedPerpSelection, fetchPerpSelection, loadPerpSelection, loadPerpsEquity, loadPerpsHistoryForRange, perpsCache, perpsMarketCache, perpsHistoryCache, validatePerpsBoard, validatePerpsHistory } from "./client";
import { equityBoard, perpBoard, perpHistory, perpRow } from "./test-fixture";
const market = (patch: Partial<PerpMarketPayload> = {}): PerpMarketPayload => ({ ...perpBoard({ rows: [perpRow()] }), evidence: [], methodologyUrl: "https://gloom.sh/docs/perpetuals", ...patch });

test("boundary refuses invalid intervals, non-finite funding, wrong market and duplicate identities while retaining null baselines", () => {
  expect(validatePerpsBoard(perpBoard()).rows[0]!.oiChange24h).toBeNull();
  for (const row of [perpRow({ fundingIntervalHours: 0 }), perpRow({ fundingRate: NaN }), perpRow({ observedAt: "invalid" })]) {
    expect(() => validatePerpsBoard(perpBoard({ rows: [row] }))).toThrow("unreadable");
  }
  expect(() => validatePerpsBoard(perpBoard({ rows: [perpRow(), perpRow()] }))).toThrow("unreadable");
  expect(() => validatePerpsHistory(perpHistory(), "another-market")).toThrow("unreadable");
  expect(validatePerpsHistory(perpHistory({ locked: true, access: "preview" })).rows).toEqual([]);
});

test("opaque canonical market identities preserve case and bypass board discovery for every venue", async () => {
  const queries: string[] = [];
  const client = {
    getCloudPerpsBoard: async () => { throw new Error("Unexpected board lookup"); },
    getCloudPerpsMarket: async (id: string) => { queries.push(id); return market(); },
  };
  for (const id of ["hyperliquid:xyz:TSLA", "hyperliquid:default:kPEPE", "binance:BTCUSDT", "kraken:PF_XBTUSD"]) await fetchPerpSelection(id, client);
  expect(queries).toEqual(["hyperliquid:xyz:TSLA", "hyperliquid:default:kPEPE", "binance:BTCUSDT", "kraken:PF_XBTUSD"]);
});

test("symbol resolution prefers default crypto and xyz stocks, including individual previews outside the board preview", async () => {
  const calls: string[] = [];
  const client = {
    getCloudPerpsBoard: async () => perpBoard({ access: "preview", rows: [], locked: 300 }),
    getCloudPerpsMarket: async (id: string) => {
      calls.push(id); return market({ rows: id === "hyperliquid:xyz:TSLA" ? [perpRow({ marketId: id, baseAsset: "TSLA" })] : [], access: "preview" });
    },
  };
  expect((await fetchPerpSelection("tsla", client)).rows[0]!.marketId).toBe("hyperliquid:xyz:TSLA");
  expect(calls).toEqual(["hyperliquid:default:TSLA", "hyperliquid:xyz:TSLA"]);
  calls.length = 0;
  const discovered = { ...client, getCloudPerpsBoard: async () => perpBoard({ rows: [perpRow({ marketId: "hyperliquid:xyz:BTC", dex: "xyz" }), perpRow()] }) };
  await fetchPerpSelection("BTC", discovered);
  expect(calls[0]).toBe(perpRow().marketId);
});

test("paid caches are isolated per account/plan and failures preserve data except access refusal", async () => {
  perpsMarketCache.reset();
  const data = market();
  const request = spyOn(apiClient, "getCloudPerpsMarket").mockResolvedValue(data);
  const id = perpRow().marketId;
  try {
    await loadPerpSelection(id, "account-a:pro");
    expect(cachedPerpSelection(id, "account-b:preview")).toBeNull();
    request.mockRejectedValue(new ApiRequestError("Gateway unavailable", 502));
    expect(await loadPerpSelection(id, "account-a:pro", true)).toMatchObject({ payload: data, stale: true, refreshError: "Gateway unavailable" });
    request.mockRejectedValue(new ApiRequestError("Session expired", 401));
    await expect(loadPerpSelection(id, "account-a:pro", true)).rejects.toThrow("Session expired");
  } finally { request.mockRestore(); perpsMarketCache.reset(); }
});

test("refresh advances the history lookback and uses the requested market's own resource", async () => {
  perpsHistoryCache.reset();
  const request = spyOn(apiClient, "getCloudPerpsHistory").mockResolvedValue(perpHistory());
  const now = spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-03T00:00:00Z"));
  try {
    await loadPerpsHistoryForRange(perpRow().marketId, 7, "account-a:pro", true);
    now.mockReturnValue(Date.parse("2026-10-04T00:00:00Z"));
    await loadPerpsHistoryForRange(perpRow().marketId, 7, "account-a:pro", true);
    expect(request.mock.calls.map(([query]) => query.from)).toEqual(["2026-09-26T00:00:00.000Z", "2026-09-27T00:00:00.000Z"]);
    expect(request.mock.calls.every(([query]) => query.marketId === perpRow().marketId && query.limit === 5000)).toBe(true);
  } finally { now.mockRestore(); request.mockRestore(); perpsHistoryCache.reset(); }
});

test("equity caches separate listings and accounts from legacy rows, and validate network and stale identities", async () => {
  perpsCache.reset();
  const nyse = { symbol: "NET", exchange: "NYSE" };
  const london = { symbol: "NET", exchange: "LSE" };
  const data = equityBoard(nyse);
  const request = spyOn(apiClient, "getCloudPerpsEquity").mockResolvedValue(data);
  try {
    await perpsCache.load("equity:NET:account-a:pro", async () => perpBoard());
    expect((await loadPerpsEquity(nyse, "account-a:pro")).payload).toEqual(data);
    expect(request.mock.calls).toEqual([["NET", "NYSE"]]);
    await expect(loadPerpsEquity(london, "account-a:pro")).rejects.toThrow("another listing");
    request.mockResolvedValue(perpBoard());
    await expect(loadPerpsEquity(nyse, "account-b:preview")).rejects.toThrow("another listing");
    request.mockRejectedValue(new ApiRequestError("Gateway unavailable", 502));
    expect(await loadPerpsEquity(nyse, "account-a:pro", true)).toMatchObject({ payload: data, stale: true });
    await expect(loadPerpsEquity(london, "account-a:pro", true)).rejects.toThrow("Gateway unavailable");
    request.mockRejectedValue(new ApiRequestError("Session expired", 401));
    await expect(loadPerpsEquity(nyse, "account-a:pro", true)).rejects.toThrow("Session expired");
    // A matching envelope cannot authorize a row associated with another listing.
    request.mockResolvedValue({ ...data, listing: london });
    await expect(loadPerpsEquity(london, "account-a:pro", true)).rejects.toThrow("another listing");
  } finally { request.mockRestore(); perpsCache.reset(); }
});
