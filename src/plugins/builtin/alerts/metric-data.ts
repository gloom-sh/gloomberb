import type { AssetDataProvider } from "../../../types/data-provider";
import type { TickerFinancials } from "../../../types/financials";
import { liveMarketCapitalization, liveTrailingPE } from "../../../market-data/quotes/live-valuation";
import { comparablePriceEarnings } from "../../../utils/price-earnings";
import { canonicalExchange } from "../../../utils/exchanges";
import { getPublishedUsEquitySession } from "../../../market-data/published-us-sessions";
import { barSessionDay } from "../../../market-data/market/period-return";
import { finalDailyBars } from "../../../time-series/session-bar";
import { DAILY_CLOSE_SETTLE_MS, dailyMetricReading, latestSettledClose, DailyMetricCache, isDailyMetric, type MetricReading } from "./metric-model";
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

export function metricAvailabilityError(rule: AlertRule): string | null {
  if (!rule.metric || !isDailyMetric(rule.metric)) return null;
  return getPublishedUsEquitySession(canonicalExchange(rule.exchange ?? ""), new Date().toISOString().slice(0, 10))
    ? null : "Daily technical alerts need a published US listing calendar; delivery is unavailable for this listing.";
}

/**
 * The first close a daily technical rule set at `now` is judged on, and when:
 * the next session to close after it, read once the close has settled
 * (DAILY_CLOSE_SETTLE_MS). Null when the listing has no published calendar.
 */
export function firstDailyCheck(exchange: string | undefined, now = Date.now()): { day: string; at: number } | null {
  const venue = canonicalExchange(exchange ?? "");
  for (let offset = 0; offset < 15; offset++) {
    const day = new Date(now + offset * 86_400_000).toISOString().slice(0, 10);
    const session = getPublishedUsEquitySession(venue, day);
    if (!session) return null;
    if (session.kind === "session" && session.close > now) return { day, at: session.close + DAILY_CLOSE_SETTLE_MS };
  }
  return null;
}

/** The bar size the daily rules read, the one `history` and the charts ask for. */
const DAILY_BARS = "1d";

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
    if (!session(new Date(now).toISOString().slice(0, 10))) throw new Error("Daily technical alerts need a published US listing calendar; delivery is unavailable for this listing.");
    const latest = latestSettledClose(now, session);
    const ruleKey = JSON.stringify([rule.id, rule.armedAt ?? rule.createdAt, key, rule.condition, rule.targetPrice, m]);
    return daily.read(ruleKey, latest.day, now, async () => {
      const load = async () => {
        // An explicit end at the settled session avoids today's forming-bar quote read.
        const end = new Date(`${latest.day}T23:59:59Z`);
        const start = new Date(Date.parse(latest.day) - 366 * 86_400_000);
        if (provider.getDetailedPriceHistoryWithMetadata) return (await provider.getDetailedPriceHistoryWithMetadata(rule.symbol, exchange, start, end, DAILY_BARS, { cacheMode: "current" })).points;
        if (provider.getDetailedPriceHistory) return provider.getDetailedPriceHistory(rule.symbol, exchange, start, end, DAILY_BARS, { cacheMode: "current" });
        throw new Error("Completed daily history is unavailable from this connection.");
      };
      const request = history.get(key) ?? load();
      history.set(key, request);
      const points = await request;
      // Final as `history` shows it: a close it prints without `partial` is one the rule may judge.
      const bars = finalDailyBars(points, { now, venue: exchange }).map(point => ({ date: barSessionDay(point.date.getTime(), exchange), close: point.close }));
      return dailyMetricReading(rule, bars, now, session);
    });
  };
}
