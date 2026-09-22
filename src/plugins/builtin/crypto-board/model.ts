import type { CryptoBoardPayload, CryptoBoardRow, CryptoPercentile } from "../../../api-client/crypto-board";
import type { MarketBoardRow } from "../../../components/market-board";
import { formatCompact } from "../../../utils/format";
export function cryptoPrice(value: number | null): string {
  if (value == null) return "--";
  const decimals = value >= 1 ? 2 : value >= 0.01 ? 4 : 8;
  return value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
export const cryptoReturn = (value: number | null) =>
  value == null ? "--" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
export const cryptoVolume = (row: CryptoBoardRow) =>
  row.volume.value == null ? "--" : `${formatCompact(row.volume.value)} ${row.volume.unit}`;
export const cryptoTimestamp = (value: string | null) =>
  value == null ? "--" : `${value.slice(0, 10)} ${value.slice(11, 19)} UTC`;
export const cryptoRank = (p: CryptoPercentile) =>
  `${p.value == null ? "--" : p.value.toFixed(0)} pctl ${p.completeWindow ? "1Y" : "sample"}`;
/** Cached snapshots age from the trade, never the local retrieval or render time. */
export function currentCryptoRow(row: CryptoBoardRow, now = Date.now()): CryptoBoardRow {
  const age = row.price.asOf == null ? Infinity : now - Date.parse(row.price.asOf);
  const freshness =
    age > 86_400_000 || age < -60_000
      ? "unavailable"
      : age > 30 * 60_000 && row.price.freshness === "current"
        ? "stale"
        : row.price.freshness;
  if (freshness === row.price.freshness) return row;
  if (freshness === "unavailable")
    return {
      ...row,
      status: "partial",
      price: {
        ...row.price,
        value: null,
        freshness,
        percentile: { ...row.price.percentile, value: null, rank: null },
      },
      dailyChange: {
        ...row.dailyChange,
        valuePercent: null,
        percentile: { ...row.dailyChange.percentile, value: null, rank: null },
      },
    };
  return { ...row, status: "partial", price: { ...row.price, freshness } };
}
export interface CryptoMarketBoardRow extends MarketBoardRow {
  observation: CryptoBoardRow;
}
export function cryptoBoardRow(input: CryptoBoardRow, now = Date.now()): CryptoMarketBoardRow {
  const row = currentCryptoRow(input, now),
    percentile = row.price.percentile;
  return {
    id: row.symbol,
    label: row.baseCurrency,
    value: row.price.value,
    valueText: cryptoPrice(row.price.value),
    change: row.dailyChange.valuePercent,
    changeText: cryptoReturn(row.dailyChange.valuePercent),
    percentile: percentile.value,
    percentileText:
      percentile.value == null
        ? "--"
        : `${percentile.value.toFixed(0)}${percentile.completeWindow ? " 1Y" : "*"}`,
    asOf: row.price.asOf,
    asOfText: row.price.asOf ? `${row.price.asOf.slice(5, 10)} ${row.price.asOf.slice(11, 16)}` : "--",
    status: row.price.freshness === "current" ? "available" : row.price.freshness,
    history: row.history.flatMap((point) =>
      point.close == null ? [] : [{ date: new Date(point.date), close: point.close }],
    ),
    observation: row,
  };
}
export function cryptoNotices(data: CryptoBoardPayload, now = Date.now()): string[] {
  const notices = [...data.warnings];
  for (const input of data.rows) {
    const row = currentCryptoRow(input, now);
    notices.push(...row.warnings.map((warning) => `${row.baseCurrency}: ${warning}`));
    if (row.price.freshness !== input.price.freshness)
      notices.push(
        `${row.baseCurrency}: retained latest trade is ${row.price.freshness}, as of ${cryptoTimestamp(row.price.asOf)}.`,
      );
    if (row.price.percentile.value != null && !row.price.percentile.completeWindow)
      notices.push(
        `${row.baseCurrency}: percentile marked * uses ${row.price.percentile.sampleCount} observed daily closes, not a complete year.`,
      );
  }
  return [...new Set(notices)];
}
