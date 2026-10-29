import { apiClient } from "../../../api-client";
import type { CotBoardPayload, CotClass, CotClassSummary, CotContractPayload, CotFamily, CotPayloadBase, CotPositions } from "../../../api-client/cot";
import { createPluginCache } from "../../../data/plugin-cache";
import { cachedCloudResource, loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";
import type { PricePoint } from "../../../types/financials";
import { COT_CLASSES, cotFrontPriceUnit, cotPriceMapping } from "./model";
import { futuresPriceUnit, loadFuturesContractTerms, loadFuturesPriceUnit } from "../../../market-data/futures-contract";
import { futuresBoardContract } from "../../../market-data/futures-board";

export const cotBoardCache = createPluginCache<CotBoardPayload>({ kind: "cot-board", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 15 * 60_000, expireMs: 8 * 24 * 60 * 60_000 } });
const date = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const number = (value: unknown) => value === null || typeof value === "number" && Number.isFinite(value);
const count = (value: unknown) => value === null || typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const code = (value: unknown) => typeof value === "string" && /^[0-9A-Z]{5}[0-9A-Z+]$/.test(value);
function base(data: CotPayloadBase, family: CotFamily, positions: CotPositions) {
  if (!data || data.source !== "CFTC" || data.scope !== positions || data.reportFamily !== family
    || !Array.isArray(data.gaps) || !data.gaps.every((gap) => typeof gap === "string")
    || !Array.isArray(data.classes) || data.classes.some((row) => !COT_CLASSES[family].some((option) => option.value === row.id))
    || data.asOf !== null && !date(data.asOf) || !Number.isFinite(Date.parse(data.generatedAt))
    || !["available", "partial", "unavailable"].includes(data.status)) throw new Error("The server returned an invalid COT report");
}
function summary(row: CotClassSummary, family: CotFamily) {
  if (!row || !COT_CLASSES[family].some((option) => option.value === row.id)
    || ![row.long, row.short, row.spreading].every(count) || ![row.net, row.weeklyChange, row.netPercentOfOpenInterest].every(number)
    || row.net !== (row.long == null || row.short == null ? null : row.long - row.short)
    || row.previousReportDate !== null && !date(row.previousReportDate)) throw new Error("The server returned invalid COT positions");
  for (const rank of [row.percentile1Y, row.percentile3Y]) {
    if (!rank || !Number.isSafeInteger(rank.sampleCount) || rank.sampleCount < 0 || typeof rank.completeWindow !== "boolean"
      || ![rank.min, rank.max, rank.mean, rank.rank].every(number) || !date(rank.windowStart) || !date(rank.windowEnd)
      || rank.value !== null && (!number(rank.value) || rank.value < 0 || rank.value > 100)
      || rank.historyStart !== null && !date(rank.historyStart) || rank.historyEnd !== null && !date(rank.historyEnd)) {
      throw new Error("The server returned invalid COT percentiles");
    }
  }
}
function validateCotBoard(data: CotBoardPayload, family: CotFamily, traderClass: CotClass, positions: CotPositions) {
  base(data, family, positions);
  if (!Array.isArray(data.rows) || data.traderClass !== traderClass) throw new Error("The server returned an invalid COT board");
  const seen = new Set<string>();
  for (const row of data.rows) {
    if (!code(row.contractCode) || seen.has(row.contractCode) || !date(row.reportDate) || !count(row.openInterest)
      || row.position?.id !== traderClass) throw new Error("The server returned an invalid COT market");
    seen.add(row.contractCode); summary(row.position, family);
  }
  return data;
}
export function validateCotContract(data: CotContractPayload, family: CotFamily, contractCode: string, positions: CotPositions = "futures-only") {
  base(data, family, positions);
  if (data.contract !== null && data.contract.contractCode !== contractCode || !Array.isArray(data.positions) || !Array.isArray(data.history)) {
    throw new Error("The server returned an invalid COT contract");
  }
  data.positions.forEach((row) => summary(row, family));
  let previous = "";
  for (const row of data.history) {
    if (!date(row.reportDate) || row.reportDate <= previous || !count(row.openInterest) || !Array.isArray(row.positions)
      || row.positions.some((position) => !COT_CLASSES[family].some((option) => option.value === position.id)
        || ![position.long, position.short, position.spreading].every(count)
        || position.net !== (position.long == null || position.short == null ? null : position.long - position.short))) {
      throw new Error("The server returned invalid COT history");
    }
    previous = row.reportDate;
  }
  return data;
}
const unavailable = (error: unknown) => unavailableOnServer(error, "COT history is not available yet.", [404, 503]);
export async function fetchCotBoard(family: CotFamily, traderClass: CotClass, client: Pick<typeof apiClient, "getCloudCotBoard"> = apiClient, positions: CotPositions = "futures-only") {
  try { return validateCotBoard(await client.getCloudCotBoard(family, traderClass, positions), family, traderClass, positions); }
  catch (error) { throw unavailable(error); }
}
// Futures-only boards keep the key they always had, so a cached board still opens.
const cotBoardKey = (family: CotFamily, traderClass: CotClass, positions: CotPositions) =>
  positions === "combined" ? `${family}:${traderClass}:combined` : `${family}:${traderClass}`;
const presentCotBoard = (payload: CotBoardPayload, stale: boolean, refreshError: string | null) => ({
  ...payload, gaps: [...payload.gaps, ...(refreshError ? [refreshError] : [])],
  status: stale && payload.status === "available" ? "partial" as const : payload.status,
});
export function cachedCotBoard(family: CotFamily, traderClass: CotClass, positions: CotPositions = "futures-only") {
  const cached = cachedCloudResource(cotBoardCache, cotBoardKey(family, traderClass, positions), (payload) => validateCotBoard(payload, family, traderClass, positions));
  return cached ? presentCotBoard(cached.payload, false, null) : null;
}
export async function loadCotBoard(family: CotFamily, traderClass: CotClass, force = false, positions: CotPositions = "futures-only") {
  const { payload, stale, refreshError } = await loadCloudResource(cotBoardCache, cotBoardKey(family, traderClass, positions),
    () => fetchCotBoard(family, traderClass, apiClient, positions), { force });
  return presentCotBoard(payload, stale, refreshError);
}
export async function fetchCotContract(contractCode: string, family: CotFamily, client: Pick<typeof apiClient, "getCloudCotContract"> = apiClient, positions: CotPositions = "futures-only") {
  try { return validateCotContract(await client.getCloudCotContract(contractCode, family, positions), family, contractCode, positions); }
  catch (error) { throw unavailable(error); }
}
/** `priceUnit` is the front price's, as its legend writes it after the price (cotFrontPriceUnit): `USD/gal` for heating oil. */
export interface CotDetailData { payload: CotContractPayload; price: PricePoint[]; priceSymbol: string | null; priceAsOf: string | null; priceWarning: string | null;
  priceUnit?: string | null }
/**
 * A market's report and its front price. The price's unit is the contract's,
 * from its terms where the client reads them, else the futures catalog's.
 */
export async function loadCotDetail(contractCode: string, family: CotFamily,
  client: Pick<typeof apiClient, "getCloudCotContract" | "getCloudHistory"> & Partial<Pick<typeof apiClient, "getCloudFuturesContract">> = apiClient,
  positions: CotPositions = "futures-only"): Promise<CotDetailData> {
  const payload = await fetchCotContract(contractCode, family, client, positions);
  const mapping = cotPriceMapping(contractCode);
  // An unmapped market simply has no price panel; that is not a data failure.
  if (!mapping?.priceSymbol) return { payload, price: [], priceSymbol: null, priceAsOf: null, priceWarning: null };
  const terms = client.getCloudFuturesContract;
  const priceUnit = (terms ? loadFuturesPriceUnit(mapping.priceSymbol, (symbol) => loadFuturesContractTerms(symbol, { getCloudFuturesContract: terms }))
    : Promise.resolve(futuresPriceUnit(futuresBoardContract(mapping.priceSymbol), null)))
    .then((unit) => cotFrontPriceUnit(contractCode, unit));
  try {
    const result = await client.getCloudHistory(mapping.priceSymbol, mapping.exchange, { interval: "1day", rangeKey: "5Y", outputsize: 1500 });
    if (!Array.isArray(result.data)) throw new Error("Front-price history unavailable");
    const start = payload.history[0]?.reportDate ?? payload.asOf;
    const seen = new Map<number, PricePoint>();
    for (const point of result.data) {
      const time = Date.parse(point.date);
      if (Number.isFinite(time) && Number.isFinite(point.close) && time <= Date.now()
        && (!start || time >= Date.parse(start))) seen.set(time, { date: new Date(time), close: point.close });
    }
    const price = [...seen.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
    return { payload, price, priceSymbol: mapping.priceSymbol, priceAsOf: price.at(-1)?.date.toISOString().slice(0, 10) ?? null,
      priceWarning: result.stale ? "Front-price history is stale." : price.length ? null : "Front-price history unavailable.", priceUnit: await priceUnit };
  } catch { return { payload, price: [], priceSymbol: mapping.priceSymbol, priceAsOf: null, priceWarning: "Front-price history unavailable. Positioning remains available." }; }
}
