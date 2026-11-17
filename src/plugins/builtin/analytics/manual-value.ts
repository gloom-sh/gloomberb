import type { Portfolio, TickerRecord } from "../../../types/ticker";
import { riskInstrumentId, riskInstrumentOf, type RiskMarketSnapshot } from "./risk-client";
import { evidenceDay } from "./risk-evidence";
import { bridgedFxClose } from "./risk-fx";

export function manualPortfolioValue(
  portfolio: Portfolio,
  tickers: readonly TickerRecord[],
  market: RiskMarketSnapshot,
  cash: number | null,
) {
  if (portfolio.brokerId || portfolio.brokerInstanceId || portfolio.brokerAccountId) return null;
  if (tickers.some((ticker) => ticker.metadata.positions.some((position) =>
    position.portfolio === portfolio.id && position.shares !== 0 && position.broker !== "manual"))) return null;
  const histories = new Map(market.histories.map((history) => [riskInstrumentId(history.instrument), history]));
  const lots = tickers.flatMap((ticker) => ticker.metadata.positions
    .filter((position) => position.portfolio === portfolio.id && position.shares !== 0)
    .map((position) => ({
      symbol: ticker.metadata.ticker,
      start: position.dateAcquired,
      quantity: (position.side === "short" ? -Math.abs(position.shares) : position.shares) * (position.multiplier ?? 1),
      history: histories.get(riskInstrumentId(riskInstrumentOf(ticker))),
    })));
  if (!lots.length && !cash) return null;
  const dates = [...new Set(market.histories.flatMap((history) => history.closes?.map((point) => point.date) ?? []))].sort();
  const starts = lots.map((lot) => lot.start ?? dates[0]).filter((date): date is string => !!date);
  const start = starts.sort()[0] ?? dates[0];
  const warnings = new Set<string>();
  if (cash == null) warnings.add("Estimated value: cash FX unavailable.");
  for (const lot of lots) {
    if (lot.start && !evidenceDay(lot.start)) warnings.add(`Estimated value: invalid acquired date for ${lot.symbol}.`);
    if (!lot.history?.closes?.length) warnings.add(`Estimated value: daily closes unavailable for ${lot.symbol}.`);
  }
  const closes = lots.map((lot) => new Map(lot.history?.closes?.map((point) => [point.date, point.close])));
  const points = dates.filter((date) => start && date >= start).map((date) => {
    let value = cash;
    const fx = portfolio.currency === "USD" ? 1 : market.accountFx && !market.accountFx.error
      && market.accountFx.first && market.accountFx.asOf && date >= market.accountFx.first && date <= market.accountFx.asOf
      ? bridgedFxClose((day) => market.accountFx!.closes[day], date)?.rate : null;
    for (const [index, lot] of lots.entries()) {
      if (lot.start && evidenceDay(lot.start) && date < lot.start) continue;
      const close = closes[index]!.get(date);
      if (value == null || close == null || !fx || !Number.isFinite(lot.quantity) || (lot.start && !evidenceDay(lot.start))) {
        value = null;
        break;
      }
      value += lot.quantity * close / fx;
    }
    return { date, value: value != null && Number.isFinite(value) ? value : null };
  });
  if (points.some((point) => point.value == null)) warnings.add("Estimated value has gaps where daily closes or FX are missing.");
  if (points.filter((point) => point.value != null).length < 2) warnings.add("Estimated value needs at least two available daily closes.");
  return {
    kind: "estimate" as const,
    label: "Estimated value",
    currency: portfolio.currency,
    points,
    warnings: [...warnings],
    complete: points.length > 1 && points.every((point) => point.value != null),
  };
}
