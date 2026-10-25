import type { AssetDataProvider } from "../../../types/data-provider";
import type { TickerFinancials } from "../../../types/financials";
import { liveMarketCapitalization, liveTrailingPE } from "../../../market-data/quotes/live-valuation";
import { comparablePriceEarnings } from "../../../utils/price-earnings";
import { canonicalExchange } from "../../../utils/exchanges";
import { getPublishedUsEquitySession } from "../../../market-data/published-us-sessions";
import { barSessionDay } from "../../../market-data/market/period-return";
import { dailyMetricReading, isDailyMetric, type MetricReading } from "./metric-model";
import type { AlertRule } from "./types";

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

/** A pass shares each listing's reads; there is no second provider or quote subscription. */
export function metricReadings(provider: AssetDataProvider, now = Date.now()) {
  const financials = new Map<string, Promise<TickerFinancials>>();
  const history = new Map<string, Promise<Awaited<ReturnType<AssetDataProvider["getPriceHistory"]>> >>();
  return async (rule: AlertRule): Promise<MetricReading> => {
    const m = rule.metric!;
    const key = `${rule.symbol}|${rule.exchange ?? ""}`;
    const data = financials.get(key) ?? provider.getTickerFinancials(rule.symbol, rule.exchange);
    financials.set(key, data);
    const loaded = await data;
    if (!isDailyMetric(m)) {
      const value = valuationAlertValue(m.kind as "pe" | "ps", loaded);
      if (value == null) throw new Error(m.kind === "pe" ? "Trailing P/E is unavailable or not meaningful." : "Trailing P/S is unavailable on a matching currency basis.");
      return { value, target: rule.targetPrice, at: loaded.quote?.lastUpdated ?? now };
    }
    const exchange = canonicalExchange(rule.exchange || loaded.quote?.listingExchangeName || loaded.quote?.exchangeName || "");
    const today = new Date(now).toISOString().slice(0, 10);
    if (!getPublishedUsEquitySession(exchange, today)) throw new Error("Daily technical alerts need a listing with a published close calendar (US equities).");
    const request = history.get(key) ?? provider.getPriceHistory(rule.symbol, exchange, "1Y");
    history.set(key, request);
    const points = await request;
    const bars = points.filter(point => !point.partial).map(point => ({ date: barSessionDay(point.date.getTime(), exchange), close: point.close }));
    return dailyMetricReading(rule, bars, now, day => getPublishedUsEquitySession(exchange, day));
  };
}
