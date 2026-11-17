import { expect, spyOn, test } from "bun:test";
import { apiClient } from "../../../api-client";
import type { CotBoardPayload, CotContractPayload } from "../../../api-client/cot";
import { cachedCotBoard, cotBoardCache, fetchCotBoard, fetchCotContract, loadCotBoard, loadCotDetail } from "./client";
import { cotHeadless } from "./headless";
import { cotModule } from "./index";
import { cotContractCode, cotPriceMapping } from "./model";
import { COT_SERIES } from "./series";

function icePayload(code = "ICE00B"): CotContractPayload {
  const percentile = { value: null, rank: null, sampleCount: 1, windowStart: "2025-11-03", windowEnd: "2026-11-03",
    historyStart: "2026-11-03", historyEnd: "2026-11-03", completeWindow: false, min: 171603, max: 171603, mean: 171603 };
  const position = { id: "managed-money" as const, label: "Managed Money", long: 290089, short: 118486, spreading: 204131, net: 171603,
    netPercentOfOpenInterest: 7.0503, weeklyChange: null, previousReportDate: null, percentile1Y: percentile, percentile3Y: percentile };
  return { source: "ICE Futures Europe", scope: "futures-only", reportFamily: "disaggregated", generatedAt: "2026-11-17T00:00:00Z",
    asOf: "2026-11-03", publishedAt: "2026-11-06T18:30:00.000Z", fetchedAt: "2026-11-06T18:35:00.000Z", status: "partial", gaps: [],
    classes: [{ id: "managed-money", label: "Managed Money" }], openInterest: 2433965, sourceUrl: null,
    contract: { contractCode: code, marketName: "ICE Brent Crude Futures - ICE Futures Europe", exchangeCode: "ICEU", commodityCode: "B", contractUnits: "CONTRACTS OF 1,000 BARRELS" },
    positions: [position], history: [{ reportDate: "2026-11-03", publishedAt: "2026-11-06T18:30:00.000Z", openInterest: 2433965, positions: [position] }] };
}

test("opted-in readers accept mixed and ICE replies as well as CFTC-only replies from older servers", async () => {
  const { contract, history, openInterest, positions, sourceUrl, ...base } = icePayload();
  const iceRow = { ...contract!, reportDate: history[0]!.reportDate, openInterest, position: positions[0]!, status: "available" as const };
  const cftcRow = { ...iceRow, contractCode: "067411", marketName: "ICE WTI" };
  const mixed: CotBoardPayload = { ...base, traderClass: "managed-money", rows: [cftcRow, iceRow], source: "CFTC / ICE Futures Europe" };
  const cftc: CotBoardPayload = { ...mixed, rows: [cftcRow], source: "CFTC" };
  for (const payload of [cftc, mixed]) {
    expect(await fetchCotBoard("disaggregated", "managed-money", { getCloudCotBoard: async () => payload })).toEqual(payload);
  }
  const brent = icePayload();
  const wti: CotContractPayload = { ...brent, contract: cftcRow, source: "CFTC" };
  for (const payload of [brent, wti]) {
    expect(await fetchCotContract(payload.contract!.contractCode, "disaggregated", { getCloudCotContract: async () => payload })).toEqual(payload);
  }

  const spy = spyOn(apiClient, "getCloudCotBoard").mockResolvedValue(mixed);
  cotBoardCache.reset();
  try {
    await cotBoardCache.load("disaggregated:managed-money", async () => cftc);
    expect(cachedCotBoard("disaggregated", "managed-money")).toBeNull();
    expect(await loadCotBoard("disaggregated", "managed-money")).toEqual(mixed);
    expect(cotBoardCache.get("disaggregated:managed-money")?.data).toEqual(cftc);
  } finally {
    cotBoardCache.reset();
    spy.mockRestore();
  }
});

test("ICE names open their own report in the pane and headless path, without replacing US commodity aliases", async () => {
  const markets = [["brent", "ICE00B"], ["gasoil", "ICE00G"], ["dubai", "ICEDBI"], ["ice cocoa", "ICE00C"],
    ["robusta coffee", "ICE0RC"], ["white sugar", "ICE00W"], ["ice wheat", "ICE00T"], ["ice wti", "067411"]] as const;
  const template = cotModule.paneTemplates![0]!;
  for (const [argument, code] of markets) {
    expect(cotContractCode(argument)).toBe(code);
    expect(cotContractCode(code)).toBe(code);
    const family = code.startsWith("ICE") ? "disaggregated" : "legacy";
    expect(await template.createInstance!({ activeTicker: null } as never, { arg: argument } as never))
      .toMatchObject({ params: { code }, settings: { report: family } });
    const reply = icePayload(code);
    if (family === "legacy") {
      reply.source = "CFTC"; reply.reportFamily = "legacy";
      reply.classes = [{ id: "noncommercial", label: "Noncommercial" }];
      reply.positions = reply.positions.map((row) => ({ ...row, id: "noncommercial", label: "Noncommercial" }));
      reply.history = reply.history.map((row) => ({ ...row, positions: row.positions.map((position) => ({ ...position, id: "noncommercial" })) }));
    }
    const asked: unknown[][] = [];
    const result = await cotHeadless.load({ argument, symbols: [], options: {} } as never,
      { apiClient: { getCloudCotContract: async (...args: unknown[]) => { asked.push(args); return reply; } } } as never);
    expect(asked).toEqual([[code, family, "futures-only", undefined]]);
    expect(result).toMatchObject({ metadata: { source: reply.source, openInterest: 2433965 }, freshness: { publisher: family === "legacy" ? "Commodity Futures Trading Commission (CFTC)" : "ICE Futures Europe" } });
  }
  expect(["cocoa", "coffee", "sugar", "wheat", "CL", "BZ"].map(cotContractCode))
    .toEqual(["073732", "083731", "080732", "001602", "067651", "06765T"]);
});

test("Brent overlays the standard Brent front price; unmapped ICE markets never substitute US prices", async () => {
  const asked: string[] = [];
  const detail = await loadCotDetail("ICE00B", "disaggregated", { getCloudCotContract: async () => icePayload(),
    getCloudHistory: async (symbol, exchange) => { asked.push(`${symbol} ${exchange}`); return { status: "success", data: [{ date: "2026-11-03", close: 65 }] } as never; } });
  expect(asked).toEqual(["BZ=F NYM"]);
  expect(detail.priceSymbol).toBe("BZ=F");
  expect(detail.price[0]?.close).toBe(65);
  for (const code of ["ICE00G", "ICEDBI", "ICE00C", "ICE0RC", "ICE00W", "ICE00T", "067411"]) {
    expect(cotPriceMapping(code)?.priceSymbol).toBeNull();
    const data = await loadCotDetail(code, "disaggregated", { getCloudCotContract: async () => icePayload(code),
      getCloudHistory: async () => { throw new Error("must not request a substitute"); } });
    expect(data.priceSymbol).toBeNull();
    expect(data.priceWarning).toBeNull();
  }
});

test("ICE exports never fill unknown publication times from the CFTC calendar", async () => {
  const reply = icePayload(); reply.publishedAt = null;
  reply.history[0]!.publishedAt = null;
  const result = await cotHeadless.load({ argument: "brent", symbols: [], options: {} } as never,
    { apiClient: { getCloudCotContract: async () => reply } } as never);
  expect(result).toMatchObject({ metadata: { publishedAt: null }, freshness: { publisher: "ICE Futures Europe" }, sections: [{}, { rows: [{ released: null }] }] });
});

test("ICE series discovery loads managed money from disaggregated, not the legacy class", async () => {
  const spy = spyOn(apiClient, "getCloudCotContract").mockResolvedValue(icePayload());
  try {
    const series = COT_SERIES.find((series) => series.id === "cot:brent-managed-money-net")!;
    const result = await series.load!({});
    expect(spy.mock.calls[0]?.slice(0, 2)).toEqual(["ICE00B", "disaggregated"]);
    expect(result).toMatchObject({ points: [{ date: new Date("2026-11-03"), value: 171603 }] });
  } finally { spy.mockRestore(); }
});
