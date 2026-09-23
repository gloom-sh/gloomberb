import type { ScreenMetric, ScreenRow } from "../../../api-client/equity-screener";
import type { QueryEntry } from "../../../market-data/result-types";
import { buildQuoteKey, resolveEntryData } from "../../../market-data/selectors";
import type { Quote } from "../../../types/financials";

const finite = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

function metricTime(metric: ScreenMetric | undefined): number | null {
  const stamp = metric?.observedAt ?? metric?.asOf ?? null;
  if (!stamp) return null;
  const time = Date.parse(stamp);
  return Number.isFinite(time) ? time : null;
}

function screenRowQuoteKey(row: Pick<ScreenRow, "symbol" | "exchange">): string {
  return buildQuoteKey({ symbol: row.symbol, exchange: row.exchange });
}

function liveMetric(metric: ScreenMetric, value: number, observedAt: string): ScreenMetric {
  return { ...metric, value, asOf: observedAt, observedAt, state: "available" };
}

/**
 * Price, day change, volume and market cap from a live quote, over a snapshot
 * row. Market cap scales with price so it keeps the snapshot's share basis.
 * Membership, sort order and percentiles stay the snapshot's, so rows neither
 * reshuffle nor vanish between snapshots. A quote in another currency unit
 * (GBp against GBP) or older than the snapshot leaves the row alone.
 */
function overlayLiveScreenRow(row: ScreenRow, quote: Quote | null): ScreenRow {
  if (!quote || quote.stale === true || !finite(quote.price) || quote.price <= 0) return row;
  const snapshotPrice = row.metrics.price;
  if (!snapshotPrice) return row;
  const quoteCurrency = quote.currency?.trim();
  if (quoteCurrency && row.currency && quoteCurrency !== row.currency) return row;
  const snapshotAt = metricTime(snapshotPrice);
  if (snapshotAt != null && finite(quote.lastUpdated) && quote.lastUpdated < snapshotAt) return row;
  if (!finite(quote.lastUpdated)) return row;
  if (snapshotPrice.value === quote.price && row.metrics.changePercent?.value === quote.changePercent) return row;

  const observedAt = new Date(quote.lastUpdated).toISOString();
  const metrics = { ...row.metrics, price: liveMetric(snapshotPrice, quote.price, observedAt) };
  if (finite(quote.changePercent) && metrics.changePercent) {
    metrics.changePercent = liveMetric(metrics.changePercent, quote.changePercent, observedAt);
  }
  if (finite(quote.volume) && quote.volume >= 0 && metrics.volume) {
    metrics.volume = liveMetric(metrics.volume, quote.volume, observedAt);
  }
  const cap = metrics.marketCap;
  if (cap && finite(cap.value) && finite(snapshotPrice.value) && snapshotPrice.value > 0) {
    metrics.marketCap = liveMetric(cap, cap.value * (quote.price / snapshotPrice.value), observedAt);
  }
  return { ...row, metrics };
}

/** The last overlay per snapshot row, so a row whose quote did not move keeps its object. */
const liveRows = new WeakMap<ScreenRow, { quote: Quote | null; row: ScreenRow }>();

export function overlayLiveScreenRows(
  rows: readonly ScreenRow[],
  entries: ReadonlyMap<string, QueryEntry<Quote>>,
): ScreenRow[] {
  return rows.map((row) => {
    const entry = entries.get(screenRowQuoteKey(row));
    if (!entry) return row;
    const quote = resolveEntryData(entry);
    const cached = liveRows.get(row);
    if (cached && cached.quote === quote) return cached.row;
    const next = overlayLiveScreenRow(row, quote);
    liveRows.set(row, { quote, row: next });
    return next;
  });
}
