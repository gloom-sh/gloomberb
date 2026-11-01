import { expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import type { CotClassSummary, CotContractPayload } from "../../../api-client/cot";
import { fetchCotBoard, loadCotDetail, loadCotPriceUnit, validateCotContract } from "./client";
import { resetFuturesPriceUnits } from "../../../market-data/futures-contract";
import {
  COT_MAJOR_CODES, COT_ROOT_OPTIONS, cotChartSeries, cotContractCode, cotContractCodeForTicker, cotContractUnitText, cotFrontPriceUnit, cotLegendValue,
  cotNetPoints, cotPriceMapping, cotProxyFor, cotProxyNote, cotScope, cotUnknownMarketMessage,
} from "./model";
import { FUTURES_CONTRACTS } from "../../../market-data/futures-board";
import { cotModule } from "./index";
import { cotHeadless } from "./headless";
import { getPaneFunctionCapability, normalizeCapabilityOptions } from "../../../cli/pane-functions/capabilities";
import { parsePaneFunctionArgs } from "../../../cli/pane-functions/options";
import { parseCliGlobalArgs } from "../../../cli/options";

function position(): CotClassSummary {
  const percentile = { value: null, rank: null, sampleCount: 2, windowStart: "2025-09-15", windowEnd: "2026-09-15",
    historyStart: "2026-09-01", historyEnd: "2026-09-15", completeWindow: false, min: -20, max: 0, mean: -10 };
  return { id: "noncommercial", label: "Noncommercial", long: 10, short: 30, spreading: 0, net: -20, netPercentOfOpenInterest: -10,
    weeklyChange: null, previousReportDate: "2026-09-01", percentile1Y: percentile,
    percentile3Y: { ...percentile, windowStart: "2023-09-15" } };
}
function payload(): CotContractPayload {
  return { source: "CFTC", scope: "futures-only", reportFamily: "legacy", generatedAt: "2026-09-22T12:00:00Z", asOf: "2026-09-15",
    fetchedAt: "2026-09-18T20:00:00Z", publishedAt: null, status: "partial", gaps: ["Limited history"],
    classes: [{ id: "noncommercial", label: "Noncommercial" }],
    contract: { contractCode: "067651", marketName: "WTI-PHYSICAL", exchangeCode: "NYM", commodityCode: "067" },
    sourceUrl: "https://www.cftc.gov/dea/newcot/deafut.txt", openInterest: 200, positions: [position()],
    history: [{ reportDate: "2026-09-01", openInterest: 180, positions: [{ id: "noncommercial", long: 20, short: 20, spreading: 0, net: 0, netPercentOfOpenInterest: 0 }] },
      { reportDate: "2026-09-15", openInterest: 200, positions: [{ id: "noncommercial", long: 10, short: 30, spreading: 0, net: -20, netPercentOfOpenInterest: -10 }] }],
  };
}

test("position charts retain missing-week gaps, zero net and alphanumeric identities", () => {
  const data = validateCotContract(payload(), "legacy", "067651");
  expect(cotNetPoints(data.history, "noncommercial").map((point) => [point.date.toISOString().slice(0, 10), point.value])).toEqual([
    ["2026-09-01", 0], ["2026-09-08", null], ["2026-09-15", -20],
  ]);
  // A holiday-shifted report eight days on is the next week, not a missing one.
  const shifted = { ...data, history: [data.history[0]!, { ...data.history[1]!, reportDate: "2026-09-09" }] };
  expect(cotNetPoints(shifted.history, "noncommercial").map((point) => point.value)).toEqual([0, -20]);
  expect(cotContractCode("001602")).toBe("001602");
  expect(cotContractCode("1170e1")).toBe("1170E1");
  expect(cotContractCode("13874+")).toBe("13874+");
  expect(cotContractCode("../067651")).toBeNull();
  expect(data.publishedAt).toBeNull();
});

test("rejects report-family contamination, identity mismatch and net inferred from suppressed legs", () => {
  expect(() => validateCotContract(payload(), "disaggregated", "067651")).toThrow("invalid COT report");
  expect(() => validateCotContract(payload(), "legacy", "067411")).toThrow("invalid COT contract");
  const bad = payload(); bad.positions[0]!.long = null;
  expect(() => validateCotContract(bad, "legacy", "067651")).toThrow("invalid COT positions");
  const revised = payload(); revised.positions[0] = { ...position(), long: null, net: null, netPercentOfOpenInterest: null };
  expect(validateCotContract(revised, "legacy", "067651").positions[0]!.net).toBeNull();
});

test("price-source failure leaves report history readable and never substitutes a cash index", async () => {
  const result = await loadCotDetail("067651", "legacy", { getCloudCotContract: async () => payload(), getCloudHistory: async () => { throw new Error("price unavailable"); } });
  expect(result.payload.history).toHaveLength(2);
  expect(result.price).toEqual([]);
  expect(result.priceWarning).toContain("Positioning remains available");
  const vx = payload(); vx.contract = { ...vx.contract!, contractCode: "1170E1", marketName: "VIX FUTURES" };
  let priceRequested = false;
  const resultVx = await loadCotDetail("1170E1", "legacy", { getCloudCotContract: async () => vx, getCloudHistory: async () => { priceRequested = true; throw new Error("must not substitute cash VIX"); } });
  expect(priceRequested).toBe(false);
  expect(resultVx.priceSymbol).toBeNull();
  expect(resultVx.priceWarning).toBeNull();
  const corn = payload(); corn.contract = { ...corn.contract!, contractCode: "002602", marketName: "CORN" };
  const requested: string[] = [];
  const resultCorn = await loadCotDetail("002602", "legacy", { getCloudCotContract: async () => corn,
    getCloudHistory: async (symbol, exchange) => { requested.push(`${symbol} ${exchange}`); return { status: "success", data: [] } as never; } });
  expect(requested).toEqual(["ZC=F CBT"]);
  expect(resultCorn.priceSymbol).toBe("ZC=F");
});

test("every FUT board root the CFTC reports opens by root as an argument; under the cursor a code a security keeps stays the security's", async () => {
  for (const row of FUTURES_CONTRACTS) {
    const code = cotContractCode(row.code);
    // Each root opens its market, whose front price is that root's own future or, without five years of it, none.
    if (code) expect([row.symbol, null]).toContain(cotPriceMapping(code)?.priceSymbol ?? null);
    else expect(cotUnknownMarketMessage(row.code)).toBe(`${row.code} (${row.name}) is not reported in the CFTC COT.`);
  }
  expect(["NG", "ho", "RB", "BZ", "HG", "PL", "PA", "ZC", "ZM", "6E", "OJ", "NG=F"].map(cotContractCode))
    .toEqual(["023651", "022651", "111659", "06765T", "085692", "076651", "075651", "002602", "026603", "099741", "040701", "023651"]);
  expect(["TTF", "ALI"].map(cotContractCode)).toEqual([null, null]);
  // Sector, index and energy roots: priced where the alias has the history, positioning alone where it does not.
  expect(["XAE", "XAF", "MES", "NIY", "EMD", "RX", "HH"].map(cotContractCode))
    .toEqual(["138749", "13874C", "13874U", "240743", "33874A", "124606", "023A55"]);
  expect(["138749", "33874A", "023A55"].map((code) => cotPriceMapping(code)?.priceSymbol ?? null)).toEqual(["XAE=F", null, null]);
  expect(["SXO", "QM", "MCL"].map(cotContractCode)).toEqual([null, null, null]);
  // Under the cursor, Zoom stays Zoom and NovaGold NovaGold; their futures symbols and a code no security uses claim the market.
  expect(["ZM", "NG", "PL", "ZM=F", "NG=F", "ZW", "6E"].map(cotContractCodeForTicker))
    .toEqual([null, null, null, "026603", "023651", "001602", "099741"]);
  const template = cotModule.paneTemplates![0]!;
  expect(await template.createInstance!({ activeTicker: null } as never, { arg: "NG" } as never)).toMatchObject({ title: "COT NG", params: { code: "023651" } });
});

test("CME crypto roots name their CFTC market, and only a typed argument or crypto ticker opens one", async () => {
  expect(["BTC", "eth", "MBT", "MET", "XRP", "SOL", "btc=f"].map(cotContractCode)).toEqual(["133741", "146021", "133742", "146022", "176740", "177741", "133741"]);
  expect(COT_ROOT_OPTIONS.filter((row) => ["BTC", "MBT", "MET", "XRP"].includes(row.value)).map((row) => row.label))
    .toEqual(["BTC Bitcoin", "MBT Micro Bitcoin", "MET Micro Ether", "XRP"]);
  // BTC and ETH are Grayscale's mini trusts and MET is MetLife: under the cursor, the bare symbol is the equity's.
  expect(["BTC", "ETH", "MBT", "MET", "SOL", "XRP"].map(cotContractCodeForTicker)).toEqual([null, null, null, null, null, null]);
  expect(["BTC-USD", "eth-usd", "BTC=F", "MBT=F", "XRP-USD", "SOL=F"].map(cotContractCodeForTicker)).toEqual(["133741", "146021", "133741", "133742", "176740", "177741"]);
  // A micro is a product, not a coin: no pair stands for it.
  expect(["MBT-USD", "MET-USD", "DOGE-USD", "ZM", null].map(cotContractCodeForTicker)).toEqual([null, null, null, null, null]);
  // The roots that already follow the cursor still do, as does a typed CFTC code.
  expect(["ES", "CL=F", "067651"].map(cotContractCodeForTicker)).toEqual(["13874A", "067651", "067651"]);

  const template = cotModule.paneTemplates![0]!;
  const open = (arg: string | undefined, activeTicker: string | null) => template.createInstance!({ activeTicker } as never, { arg } as never);
  expect(await open("BTC", "AAPL")).toMatchObject({ title: "COT BTC", params: { code: "133741" } });
  expect(await open("mbt", null)).toMatchObject({ title: "COT MBT", params: { code: "133742" } });
  expect(await open(undefined, "BTC")).toMatchObject({ title: "CFTC Positioning", params: undefined });
  expect(await open(undefined, "ETH-USD")).toMatchObject({ title: "COT ETH", params: { code: "146021" } });

  // Bitcoin and ether chart their front price; the micros, XRP and SOL have no five-year history to chart.
  const requested: string[] = [];
  const detail = (code: string) => loadCotDetail(code, "legacy", { getCloudCotContract: async () => ({ ...payload(), contract: { ...payload().contract!, contractCode: code } }),
    getCloudHistory: async (symbol) => { requested.push(symbol); return { status: "success", data: [] } as never; } });
  expect((await detail("133741")).priceSymbol).toBe("BTC=F");
  expect((await detail("146021")).priceSymbol).toBe("ETH=F");
  for (const code of ["133742", "146022", "176740", "177741"]) expect(await detail(code)).toMatchObject({ priceSymbol: null, priceWarning: null });
  expect(requested).toEqual(["BTC=F", "ETH=F"]);
});

test("missing migration gives unavailable state; access failures remain access failures", async () => {
  await expect(fetchCotBoard("legacy", "noncommercial", { getCloudCotBoard: async () => { throw new ApiRequestError("not ready", 503); } })).rejects.toThrow("not available yet");
  const denied = new ApiRequestError("Forbidden", 403);
  await expect(fetchCotBoard("legacy", "noncommercial", { getCloudCotBoard: async () => { throw denied; } })).rejects.toBe(denied);
});

test("major scope keeps only verified codes and never invents a market", () => {
  expect(cotScope("all")).toBe("all");
  expect(cotScope(undefined)).toBe("major");
  expect(COT_MAJOR_CODES.has("13874A")).toBe(true);
  expect(COT_MAJOR_CODES.has("0063DB")).toBe(false);
  expect([...COT_MAJOR_CODES].every((code) => /^[0-9A-Z]{5}[0-9A-Z+]$/.test(code))).toBe(true);
});

test("legend values stay exact without the float32 tail of price bars", () => {
  expect(cotLegendValue(Math.fround(4346.3), { id: "price" })).toBe("4,346.3");
  expect(cotLegendValue(7765.25, { id: "price" })).toBe("7,765.25");
  expect(cotLegendValue(112.640625, { id: "price" })).toBe("112.640625");
  expect(cotLegendValue(-100461, { id: "net" })).toBe("-100,461");
});

test("the front price reads in its contract's unit, as a quote of the future does: heating oil per gallon", async () => {
  resetFuturesPriceUnits();
  // HO's "Front price 4.8221" said nothing of dollars or gallons.
  expect(cotFrontPriceUnit("022651", "USD / gallon")).toBe("USD/gal");
  expect(cotLegendValue(Math.fround(4.8221), { id: "price", unit: "USD/gal" })).toBe("$4.8221/gal");
  // Gold reads as a dollar price, as `quote GC=F` does; a unit with no currency (index points) leaves the number bare.
  expect(cotFrontPriceUnit("088691", "USD / troy ounce")).toBe("USD");
  expect(cotLegendValue(4346.3, { id: "price", unit: "USD" })).toBe("$4,346.3");
  expect(cotFrontPriceUnit("13874A", "index points")).toBeNull();
  // The unit comes from the contract's terms.
  const ho = payload(); ho.contract = { ...ho.contract!, contractCode: "022651", marketName: "NY HARBOR ULSD - NEW YORK MERCANTILE EXCHANGE" };
  const detail = await loadCotDetail("022651", "legacy", { getCloudCotContract: async () => ho,
    getCloudHistory: async () => ({ status: "success", data: [{ date: "2026-09-15", close: 4.8221 }] }) as never });
  const priceUnit = await loadCotPriceUnit("022651", { getCloudFuturesContract: async () => ({ symbol: "HO=F", root: "HO", name: "Heating Oil", contract: null, contractSymbol: null, deliveryMonth: null,
    spec: { unit: "USD / gallon", size: "42,000 gallons", pointValue: 42_000, tick: 0.0001, tickValue: 4.2, settlement: "physical" },
    lastTrade: null, firstNotice: null, inDelivery: false, settlement: null }) });
  expect(priceUnit).toBe("USD/gal");
  const series = cotChartSeries(ho, "noncommercial", detail.price, { positive: "#0f0", warning: "#fa0" }, priceUnit);
  expect(series.find((entry) => entry.id === "price")?.unit).toBe("USD/gal");
});

test("jet fuel and kerosene open heating oil, the usual proxy, and say so", async () => {
  for (const name of ["jet fuel", "Jet Fuel", "kerosene", "aviation fuel"]) {
    expect(cotContractCode(name), name).toBe("022651");
    expect(cotProxyFor(name), name).toEqual({ subject: "jet fuel", root: "HO" });
  }
  // A market the CFTC reports is no proxy, by name or root.
  expect(cotProxyFor("heating oil")).toBeNull();
  expect(cotProxyFor("HO")).toBeNull();
  expect(cotProxyNote({ subject: "jet fuel", root: "HO" })).toBe("Jet fuel has no CFTC market: heating oil (NY Harbor ULSD, HO) is the usual proxy. "
    + "Its price: gloom quote HO=F; US jet fuel stocks (EIA, weekly): gloom fn G CAP:doe:jet");
  const template = cotModule.paneTemplates![0]!;
  expect(await template.createInstance!({ activeTicker: null } as never, { arg: "jet fuel" } as never))
    .toMatchObject({ title: "COT HO (jet fuel proxy)", params: { code: "022651" } });
});

test("the class's net leads the chart series, ahead of the front price", () => {
  const history = ["2026-09-08", "2026-09-15"].map((reportDate, index) => ({ reportDate, openInterest: 200,
    positions: [{ id: "commercial" as const, long: 10 + index, short: 30, spreading: 0, net: index - 20, netPercentOfOpenInterest: -10 }] }));
  const data = { reportFamily: "legacy", history } as unknown as CotContractPayload;
  const price = [{ date: new Date("2026-09-15"), close: 65 }];
  const series = cotChartSeries(data, "commercial", price, { positive: "#0f0", warning: "#fa0" });
  expect(series.map((entry) => [entry.id, entry.label, entry.panelId])).toEqual([
    ["net", "Commercial net", "net"], ["price", "Front price", "price"],
  ]);
});

test("commodity names open their market as FUT finds them, before a six-letter word is read as a CFTC code", async () => {
  const names = ["cocoa", "Coffee", "SUGAR", "cotton", "OJ", "orange juice", "gold", "silver", "copper", "crude", "oil", "natural gas", "brent", "soybean", "bitcoin", "fed funds"];
  expect(names.map(cotContractCode)).toEqual([
    "073732", "083731", "080732", "033661", "040701", "040701", "088691", "084691", "085692", "067651", "067651", "023651", "06765T", "005602", "133741", "045601",
  ]);
  // COFFEE and COPPER are six letters, as a CFTC code is; the name wins.
  expect(["COFFEE", "COPPER"].map(cotContractCode)).toEqual(["083731", "085692"]);
  // A named market the CFTC does not report says so; a name nothing matches gets codes and names that work.
  expect(cotContractCode("aluminum")).toBeNull();
  expect(cotUnknownMarketMessage("aluminum")).toBe("ALI (Aluminum) is not reported in the CFTC COT.");
  expect(cotContractCode("pork bellies")).toBeNull();
  expect(cotUnknownMarketMessage("pork bellies")).toContain("CC cocoa, KC coffee, SB sugar");
  expect(cotUnknownMarketMessage("pork bellies")).toContain("HG copper");
  const template = cotModule.paneTemplates![0]!;
  expect(await template.createInstance!({ activeTicker: null } as never, { arg: "cocoa" } as never)).toMatchObject({ title: "COT CC", params: { code: "073732" } });
});

test("a market's report lists its weeks newest first, the newest n with --limit or --tail, under its report date and contract size", async () => {
  const gold: CotContractPayload = { ...payload(), status: "available", gaps: [],
    contract: { contractCode: "088691", marketName: "GOLD - COMMODITY EXCHANGE INC.", exchangeCode: "CMX", commodityCode: "088", contractUnits: "CONTRACTS OF 100 TROY OUNCES" },
    history: ["2026-09-01", "2026-09-08", "2026-09-15"].map((reportDate, index) => ({ reportDate, openInterest: 180 + index,
      positions: [{ id: "noncommercial" as const, long: 30, short: 10 + index, spreading: 0, net: 20 - index, netPercentOfOpenInterest: 10 }] })) };
  const capability = getPaneFunctionCapability({ id: "cot-pane", paneId: "cot", label: "COT", description: "COT", headless: cotHeadless },
    { id: "cot", name: "COT", component: () => null, defaultPosition: "right" });
  const report = async (flags: string[]) => {
    const global = parseCliGlobalArgs(["fn", "COT", "gold", ...flags]);
    const options = normalizeCapabilityOptions(capability, parsePaneFunctionArgs(global.args.slice(1), global.options).options, { strict: true });
    const result = await cotHeadless.load({ argument: "gold", symbols: [], options } as never,
      { apiClient: { getCloudCotContract: async () => gold } } as never);
    return (result as { sections: Array<{ title: string; rows: Array<Record<string, unknown>> }> }).sections;
  };

  const all = await report([]);
  expect(all[0]!.title).toBe("GOLD  ·  report date 2026-09-15  ·  1 contract = 100 troy ounces");
  expect(all[1]!.title).toBe("Weekly positions");
  expect(all[1]!.rows.map((row) => row.reportDate)).toEqual(["2026-09-15", "2026-09-08", "2026-09-01"]);
  for (const flags of [["--limit", "2"], ["--tail", "2"]]) {
    const [, weeks] = await report(flags);
    expect(weeks!.title, flags.join(" ")).toBe("Weekly positions  ·  newest 2 of 3");
    expect(weeks!.rows.map((row) => row.reportDate), flags.join(" ")).toEqual(["2026-09-15", "2026-09-08"]);
  }
});

test("--report tff and --positions combined read the TFF board and contracts with options, and refuse a reply for the other scope", async () => {
  const capability = getPaneFunctionCapability({ id: "cot-pane", paneId: "cot", label: "COT", description: "COT", headless: cotHeadless },
    { id: "cot", name: "COT", component: () => null, defaultPosition: "right" });
  const asked: unknown[][] = [];
  const tff = (scope: "futures-only" | "combined"): CotContractPayload => ({ ...payload(), scope, reportFamily: "tff", status: "available", gaps: [],
    classes: [{ id: "leveraged-funds", label: "Leveraged Funds" }],
    contract: { contractCode: "13874A", marketName: "E-MINI S&P 500 - CHICAGO MERCANTILE EXCHANGE", exchangeCode: "CME", commodityCode: "138", contractUnits: "$50 X S&P 500 INDEX" },
    positions: [{ ...position(), id: "leveraged-funds", label: "Leveraged Funds" }],
    history: [{ reportDate: "2026-09-15", openInterest: 200, positions: [{ id: "leveraged-funds", long: 10, short: 30, spreading: 0, net: -20, netPercentOfOpenInterest: -10 }] }] });
  const run = async (argument: string | undefined, flags: string[], reply: "futures-only" | "combined") => {
    const global = parseCliGlobalArgs(["fn", "COT", ...(argument ? [argument] : []), ...flags]);
    const options = normalizeCapabilityOptions(capability, parsePaneFunctionArgs(global.args.slice(1), global.options).options, { strict: true });
    return cotHeadless.load({ argument, symbols: [], options } as never, { apiClient: {
      getCloudCotContract: async (...args: unknown[]) => { asked.push(["contract", ...args]); return tff(reply); },
      getCloudCotBoard: async (...args: unknown[]) => {
        asked.push(["board", ...args]);
        const { contract, positions, history, sourceUrl, openInterest, ...base } = tff(reply);
        return { ...base, traderClass: "leveraged-funds", rows: [{ ...contract!, reportDate: "2026-09-15", openInterest: 200, position: positions[0]!, status: "available" }] };
      },
    } } as never) as Promise<{ sections: Array<{ title: string; rows: Array<Record<string, unknown>> }> }>;
  };

  const detail = await run("13874A", ["--report", "tff", "--positions", "combined"], "combined");
  expect(detail.sections[0]!.title).toBe("E-MINI S&P 500  ·  report date 2026-09-15  ·  1 contract = $50 X S&P 500 INDEX  ·  futures + options");
  expect(detail.sections[0]!.rows[0]!.class).toBe("Leveraged Funds");
  const extremes = await run(undefined, ["--report", "tff", "--positions", "combined", "--scope", "all"], "combined");
  expect(extremes.sections[0]!.title).toBe("Positioning extremes  ·  futures + options");
  expect(extremes.sections[0]!.rows[0]!.contractCode).toBe("13874A");
  // Without --positions the board is futures only, as it always was.
  expect((await run(undefined, ["--report", "tff", "--scope", "all"], "futures-only")).sections[0]!.title).toBe("Positioning extremes");
  expect(asked).toEqual([
    ["contract", "13874A", "tff", "combined"],
    ["board", "tff", "leveraged-funds", "combined"],
    ["board", "tff", "leveraged-funds", "futures-only"],
  ]);
  await expect(run("13874A", ["--report", "tff", "--positions", "combined"], "futures-only")).rejects.toThrow();
  await expect(run(undefined, ["--report", "tff", "--traderClass", "managed-money"], "futures-only")).rejects.toThrow("does not belong");
});

test("the API asks for a scope only when it is combined, so the default request is the one it always was", async () => {
  const { CloudDataApi } = await import("../../../api-client/data");
  const paths: string[] = [];
  const client = new CloudDataApi((async (path: string) => { paths.push(path); return {}; }) as never);
  await client.getCloudCotBoard("legacy", "noncommercial");
  await client.getCloudCotBoard("tff", "leveraged-funds", "combined");
  await client.getCloudCotContract("13874A", "tff");
  await client.getCloudCotContract("13874A", "tff", "combined");
  expect(paths).toEqual([
    "/cloud/cot/board?report=legacy&traderClass=noncommercial",
    "/cloud/cot/board?report=tff&traderClass=leveraged-funds&scope=combined",
    "/cloud/cot/contracts/13874A?report=tff",
    "/cloud/cot/contracts/13874A?report=tff&scope=combined",
  ]);
});

test("a contract's size reads in plain words where the CFTC spells a unit, and keeps its own spelling otherwise", () => {
  expect(cotContractUnitText("CONTRACTS OF 5,000 BUSHELS")).toBe("1 contract = 5,000 bushels");
  expect(cotContractUnitText("(CONTRACTS OF JPY 12,500,000)")).toBe("1 contract = JPY 12,500,000");
  expect(cotContractUnitText("$50 X S&P 500 INDEX")).toBe("1 contract = $50 X S&P 500 INDEX");
  expect(cotContractUnitText("Contracts of 2,500  MMBTU'S")).toBe("1 contract = 2,500 MMBTU'S");
  expect(cotContractUnitText(null)).toBeNull();
});
