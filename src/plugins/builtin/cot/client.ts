import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { CotBoardPayload, CotClass, CotClassSummary, CotContractPayload, CotFamily, CotPayloadBase } from "../../../api-client/cot";
import { createPluginCache } from "../../../data/plugin-cache";
import type { PricePoint } from "../../../types/financials";
import { COT_CLASSES, cotPriceMapping } from "./model";

export const cotBoardCache = createPluginCache<CotBoardPayload>({ kind: "cot-board", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 15 * 60_000, expireMs: 8 * 24 * 60 * 60_000 } });
const date = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const number = (value: unknown) => value === null || typeof value === "number" && Number.isFinite(value);
const count = (value: unknown) => value === null || typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const code = (value: unknown) => typeof value === "string" && /^[0-9A-Z]{5}[0-9A-Z+]$/.test(value);
function base(data: CotPayloadBase, family: CotFamily) {
  if (!data || data.source !== "CFTC" || data.scope !== "futures-only" || data.reportFamily !== family
    || !Array.isArray(data.gaps) || !data.gaps.every((gap) => typeof gap === "string")
    || !Array.isArray(data.classes) || data.classes.some((row) => !COT_CLASSES[family].some((option) => option.value === row.id))
    || data.asOf !== null && !date(data.asOf) || !Number.isFinite(Date.parse(data.generatedAt))
    || !["available", "partial", "unavailable"].includes(data.status)) throw new Error("Gloom Cloud returned an invalid COT report");
}
function summary(row: CotClassSummary, family: CotFamily) {
  if (!row || !COT_CLASSES[family].some((option) => option.value === row.id)
    || ![row.long, row.short, row.spreading].every(count) || ![row.net, row.weeklyChange, row.netPercentOfOpenInterest].every(number)
    || row.net !== (row.long == null || row.short == null ? null : row.long - row.short)
    || row.previousReportDate !== null && !date(row.previousReportDate)) throw new Error("Gloom Cloud returned invalid COT positions");
  for (const rank of [row.percentile1Y, row.percentile3Y]) {
    if (!rank || !Number.isSafeInteger(rank.sampleCount) || rank.sampleCount < 0 || typeof rank.completeWindow !== "boolean"
      || ![rank.min, rank.max, rank.mean, rank.rank].every(number) || !date(rank.windowStart) || !date(rank.windowEnd)
      || rank.value !== null && (!number(rank.value) || rank.value < 0 || rank.value > 100)
      || rank.historyStart !== null && !date(rank.historyStart) || rank.historyEnd !== null && !date(rank.historyEnd)) {
      throw new Error("Gloom Cloud returned invalid COT percentiles");
    }
  }
}
export function validateCotBoard(data: CotBoardPayload, family: CotFamily, traderClass: CotClass) {
  base(data, family);
  if (!Array.isArray(data.rows) || data.traderClass !== traderClass) throw new Error("Gloom Cloud returned an invalid COT board");
  const seen = new Set<string>();
  for (const row of data.rows) {
    if (!code(row.contractCode) || seen.has(row.contractCode) || !date(row.reportDate) || !count(row.openInterest)
      || row.position?.id !== traderClass) throw new Error("Gloom Cloud returned an invalid COT market");
    seen.add(row.contractCode); summary(row.position, family);
  }
  return data;
}
export function validateCotContract(data: CotContractPayload, family: CotFamily, contractCode: string) {
  base(data, family);
  if (data.contract !== null && data.contract.contractCode !== contractCode || !Array.isArray(data.positions) || !Array.isArray(data.history)) {
    throw new Error("Gloom Cloud returned an invalid COT contract");
  }
  data.positions.forEach((row) => summary(row, family));
  let previous = "";
  for (const row of data.history) {
    if (!date(row.reportDate) || row.reportDate <= previous || !count(row.openInterest) || !Array.isArray(row.positions)
      || row.positions.some((position) => !COT_CLASSES[family].some((option) => option.value === position.id)
        || ![position.long, position.short, position.spreading].every(count)
        || position.net !== (position.long == null || position.short == null ? null : position.long - position.short))) {
      throw new Error("Gloom Cloud returned invalid COT history");
    }
    previous = row.reportDate;
  }
  return data;
}
function unavailable(error: unknown): never {
  if (error instanceof ApiRequestError && [404, 503].includes(error.status ?? 0)) throw new Error("COT history is not available on this Gloom Cloud server yet");
  throw error;
}
export async function fetchCotBoard(family: CotFamily, traderClass: CotClass, client: Pick<typeof apiClient, "getCloudCotBoard"> = apiClient) {
  try { return validateCotBoard(await client.getCloudCotBoard(family, traderClass), family, traderClass); }
  catch (error) { return unavailable(error); }
}
export async function loadCotBoard(family: CotFamily, traderClass: CotClass, force = false) {
  const result = await cotBoardCache.load(`${family}:${traderClass}`, () => fetchCotBoard(family, traderClass), { force });
  if (result.error instanceof ApiRequestError && [401, 403].includes(result.error.status ?? 0)) throw result.error;
  return { ...result.data, gaps: [...result.data.gaps, ...(result.refreshError ? [result.refreshError] : [])],
    status: result.stale && result.data.status === "available" ? "partial" as const : result.data.status };
}
export async function fetchCotContract(contractCode: string, family: CotFamily, client: Pick<typeof apiClient, "getCloudCotContract"> = apiClient) {
  try { return validateCotContract(await client.getCloudCotContract(contractCode, family), family, contractCode); }
  catch (error) { return unavailable(error); }
}
export interface CotDetailData { payload: CotContractPayload; price: PricePoint[]; priceSymbol: string | null; priceAsOf: string | null; priceWarning: string | null }
export async function loadCotDetail(contractCode: string, family: CotFamily, client: Pick<typeof apiClient, "getCloudCotContract" | "getCloudHistory"> = apiClient): Promise<CotDetailData> {
  const payload = await fetchCotContract(contractCode, family, client);
  const mapping = cotPriceMapping(contractCode);
  // An unmapped market simply has no price panel; that is not a data failure.
  if (!mapping?.priceSymbol) return { payload, price: [], priceSymbol: null, priceAsOf: null, priceWarning: null };
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
      priceWarning: result.stale ? "Front-price history is stale." : price.length ? null : "Front-price history unavailable." };
  } catch { return { payload, price: [], priceSymbol: mapping.priceSymbol, priceAsOf: null, priceWarning: "Front-price history unavailable. Positioning remains available." }; }
}
