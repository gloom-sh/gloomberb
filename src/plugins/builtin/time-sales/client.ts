import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { TapeSnapshot } from "../../../api-client/tape";
import { canonicalExchange, normalizeSymbol } from "../../../utils/exchanges";
import { tapeTimeKey, tradeKey } from "./model";

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const quantity = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === "string";
const timestamp = (value: unknown): value is string => typeof value === "string"
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value.slice(0, 10);
const day = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const nullableTime = (value: unknown) => value === null || timestamp(value);
const conditions = (value: unknown) => Array.isArray(value) && value.every(text);

export function validateTape(data: TapeSnapshot, symbol: string, exchange: string): TapeSnapshot {
  if (!data || data.source !== "Alpaca" || data.symbol !== normalizeSymbol(symbol) || canonicalExchange(data.exchange) !== canonicalExchange(exchange)
    || !timestamp(data.generatedAt) || !nullableTime(data.asOf) || !nullableTime(data.observedFrom)
    || !["available", "partial", "unavailable"].includes(data.status)
    || !Array.isArray(data.gaps) || !data.gaps.every(text) || typeof data.connected !== "boolean"
    || data.access !== "realtime" && data.access !== "delayed"
    || data.feed !== (data.access === "realtime" ? "sip" : "delayed_sip") || data.delaySeconds !== (data.access === "realtime" ? 0 : 900)
    || !data.capacity || !count(data.capacity.trades) || data.capacity.trades > 1000 || !count(data.capacity.quotes) || data.capacity.quotes > 500
    || !Array.isArray(data.trades) || data.trades.length > data.capacity.trades || !Array.isArray(data.quotes) || data.quotes.length > data.capacity.quotes
    || !data.dropped || !count(data.dropped.trades) || !count(data.dropped.quotes) || !count(data.corrections) || !count(data.cancels)) {
    throw new Error("Gloom Cloud returned an invalid tape snapshot");
  }
  const cutoffDate = new Date(Date.parse(data.generatedAt) - data.delaySeconds * 1000).toISOString();
  const cutoff = `${cutoffDate.slice(0, 19)}.${tapeTimeKey(data.generatedAt).slice(20, 29)}Z`;
  const seen = new Set<string>();
  for (const row of data.trades) {
    if (!row || !text(row.id) || !/^\d+$/.test(row.id) || !timestamp(row.timestamp) || tapeTimeKey(row.timestamp) > cutoff
      || !positive(row.price) || !positive(row.size) || !text(row.exchange) || !text(row.tape) || !conditions(row.conditions)
      || seen.has(tradeKey(row))) throw new Error("Gloom Cloud returned invalid tape trades");
    seen.add(tradeKey(row));
  }
  for (const row of data.quotes) {
    if (!row || !timestamp(row.timestamp) || tapeTimeKey(row.timestamp) > cutoff || row.bid !== null && !positive(row.bid)
      || row.ask !== null && !positive(row.ask) || !quantity(row.bidSize) || !quantity(row.askSize)
      || !text(row.bidExchange) || !text(row.askExchange) || !text(row.tape) || !conditions(row.conditions)) {
      throw new Error("Gloom Cloud returned invalid NBBO history");
    }
  }
  if (!data.session || !nullableTime(data.session.asOf)
    || data.session.date !== null && !day(data.session.date)
    || data.session.asOf !== null && tapeTimeKey(data.session.asOf) > cutoff
    || (data.session.high === null) !== (data.session.asOf === null)
    || (data.session.low === null) !== (data.session.asOf === null)
    || (data.session.date === null) !== (data.session.asOf === null) || data.session.high !== null && !positive(data.session.high)
    || data.session.low !== null && !positive(data.session.low)
    || data.session.high != null && data.session.low != null && data.session.low > data.session.high) throw new Error("Gloom Cloud returned invalid session context");
  // Normalize only event ordering. Source prices, identities and nanoseconds survive.
  return { ...data, trades: [...data.trades].sort((a, b) => tapeTimeKey(a.timestamp).localeCompare(tapeTimeKey(b.timestamp))),
    quotes: [...data.quotes].sort((a, b) => tapeTimeKey(a.timestamp).localeCompare(tapeTimeKey(b.timestamp))) };
}
export async function fetchTape(symbol: string, exchange: string, signal?: AbortSignal,
  client: Pick<typeof apiClient, "getCloudTape"> = apiClient): Promise<TapeSnapshot> {
  try { return validateTape(await client.getCloudTape(symbol, exchange, signal), symbol, exchange); }
  catch (error) {
    if (error instanceof ApiRequestError && [404, 503].includes(error.status ?? 0)) throw new Error("Time and sales is not available on this Gloom Cloud server yet");
    throw error;
  }
}
