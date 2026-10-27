import type { AssetDataProvider } from "../../../types/data-provider";
import type { TickerFinancials } from "../../../types/financials";
import { liveMarketCapitalization, liveTrailingPE } from "../../../market-data/quotes/live-valuation";
import { comparablePriceEarnings } from "../../../utils/price-earnings";
import { canonicalExchange } from "../../../utils/exchanges";
import { getPublishedUsEquitySession } from "../../../market-data/published-us-sessions";
import { barSessionDay } from "../../../market-data/market/period-return";
import { getPricePointTimestamp } from "../../../utils/price-history";
import { dailyMetricReading, latestSettledClose, DailyMetricCache, isDailyMetric, isRelativeMetric, type MetricReading } from "./metric-model";
import type { AlertRule } from "./types";

// Keep valuation fixtures in step with the delivery evaluator and the research panes.
/** Current trailing figures on the same regular-session and currency basis as the research panes. */
export function valuationAlertValue(kind: "pe" | "ps", data: TickerFinancials): number | null {
  const { quote, fundamentals: f } = data;
  if (!quote || quote.stale || !Number.isFinite(quote.price) || quote.price <= 0 || !f || f.stale) return null;
  if (kind === "pe") return comparablePriceEarnings(liveTrailingPE(quote, f));
  const cap = liveMarketCapitalization(quote, f);
  if (!cap || !f.revenue || !Number.isFinite(f.revenue) || f.revenue <= 0
    || !f.financialCurrency || cap.currency !== f.financialCurrency) return null;
  const value = cap.value / f.revenue;
  return Number.isFinite(value) && value > 0 ? value : null;
}

const US_CALENDAR = "Daily technical alerts need a published US listing calendar; delivery is unavailable for this listing.";
/** Why a rule's listings cannot be judged on settled closes: a benchmark is held to the same US calendar as the listing. */
export function metricAvailabilityError(rule: AlertRule, now = Date.now()): string | null {
  if (!rule.metric || !isDailyMetric(rule.metric)) return null;
  const today = new Date(now).toISOString().slice(0, 10);
  if (!getPublishedUsEquitySession(canonicalExchange(rule.exchange ?? ""), today)) return US_CALENDAR;
  return isRelativeMetric(rule.metric) && !getPublishedUsEquitySession(canonicalExchange(rule.metric.benchmarkExchange ?? ""), today)
    ? `Relative strength alerts compare two US listings; ${rule.metric.benchmark} has no published US listing calendar here.` : null;
}

const dailyCaches = new WeakMap<AssetDataProvider, DailyMetricCache>();

/** A pass shares each listing's reads; there is no second provider or quote subscription. */
export function metricReadings(provider: AssetDataProvider, now = Date.now()) {
  const daily = dailyCaches.get(provider) ?? new DailyMetricCache();
  dailyCaches.set(provider, daily);
  const financials = new Map<string, Promise<TickerFinancials>>();
  const history = new Map<string, Promise<Awaited<ReturnType<AssetDataProvider["getPriceHistory"]>> >>();
  return async (rule: AlertRule): Promise<MetricReading> => {
    const m = rule.metric!;
    const key = `${rule.symbol}|${rule.exchange ?? ""}`;
    if (!isDailyMetric(m)) {
      const data = financials.get(key) ?? provider.getTickerFinancials(rule.symbol, rule.exchange);
      financials.set(key, data);
      const loaded = await data;
      const value = valuationAlertValue(m.kind as "pe" | "ps", loaded);
      if (value == null) throw new Error(m.kind === "pe" ? "Trailing P/E is unavailable or not meaningful." : "Trailing P/S is unavailable on a matching currency basis.");
      return { value, target: rule.targetPrice, at: loaded.quote?.lastUpdated ?? now };
    }
    const exchange = canonicalExchange(rule.exchange ?? "");
    const session = (day: string) => getPublishedUsEquitySession(exchange, day);
    const unavailable = metricAvailabilityError(rule, now);
    if (unavailable) throw new Error(unavailable);
    const latest = latestSettledClose(now, session);
    const ruleKey = JSON.stringify([rule.id, rule.armedAt ?? rule.createdAt, key, rule.condition, rule.targetPrice, m]);
    return daily.read(ruleKey, latest.day, now, async () => {
      const load = async (symbol: string, venue: string) => {
        // An explicit end at the settled session avoids today's forming-bar quote read.
        const end = new Date(`${latest.day}T23:59:59Z`);
        const start = new Date(Date.parse(latest.day) - 366 * 86_400_000);
        if (provider.getDetailedPriceHistoryWithMetadata) return (await provider.getDetailedPriceHistoryWithMetadata(symbol, venue, start, end, "1d", { cacheMode: "current" })).points;
        if (provider.getDetailedPriceHistory) return provider.getDetailedPriceHistory(symbol, venue, start, end, "1d", { cacheMode: "current" });
        throw new Error("Completed daily history is unavailable from this connection.");
      };
      const completed = async (symbol: string, venue: string) => {
        const listing = `${symbol}|${venue}`;
        const request = history.get(listing) ?? load(symbol, venue);
        history.set(listing, request);
        // A saved copy carries its dates as text.
        return (await request).filter(point => !point.partial).map(point => ({ date: barSessionDay(getPricePointTimestamp(point), venue), close: point.close }));
      };
      const bars = await completed(rule.symbol, exchange);
      // RS ratios and RRG quadrants read the benchmark's own completed bars, never a quote.
      const benchmark = isRelativeMetric(m) ? await completed(m.benchmark, canonicalExchange(m.benchmarkExchange ?? "")) : undefined;
      return dailyMetricReading(rule, bars, now, session, benchmark);
    });
  };
}
