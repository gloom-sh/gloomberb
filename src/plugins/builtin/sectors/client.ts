import type { DataProvider } from "../../../types/data-provider";
import type { PricePoint, Quote } from "../../../types/financials";
import type { SectorDef } from "./sector-data";
import {
  computeTrailingReturn,
  latestHistoryDate,
  sectorReturnTargetDate,
  type SectorRow,
} from "./sector-model";

export interface SectorRowOutcome {
  etf: string;
  row: Partial<SectorRow> | null;
}

export async function loadSectorRows(
  sectors: readonly SectorDef[],
  provider: DataProvider,
): Promise<SectorRowOutcome[]> {
  const quotes = new Map<string, Quote | null>();
  if (provider.getQuotesBatch) {
    const results = await provider.getQuotesBatch(
      sectors.map((sector) => ({ symbol: sector.etf, exchange: "" })),
    ).catch(() => []);
    for (const result of results) quotes.set(result.target.symbol, result.quote ?? null);
  }
  // A partial batch must not silently replace a live quote with yesterday's
  // history close. Retry only the missing instruments through the normal route.
  await Promise.all(sectors.filter((sector) => !quotes.get(sector.etf)).map(async (sector) => {
    try {
      quotes.set(sector.etf, await provider.getQuote(sector.etf, ""));
    } catch {
      quotes.set(sector.etf, null);
    }
  }));

  const histories = new Map(await Promise.all(sectors.map(async (sector) => [
    sector.etf,
    await provider.getPriceHistory(sector.etf, "", "1Y").catch(() => []),
  ] as const)));
  const quoteDates = new Map([...quotes].map(([symbol, quote]) => [symbol, quote ? quoteSessionDate(quote) : null]));
  const asOfDate = [...quoteDates.values(), ...[...histories.values()].map(latestHistoryDate)]
    .filter((date): date is string => date != null).sort().at(-1) ?? null;

  const outcomes = await Promise.all(sectors.map(async (sector) => {
    let history: PricePoint[] = histories.get(sector.etf) ?? [];
    const quote = quotes.get(sector.etf) ?? null;
    if (!quote && history.length === 0) return { etf: sector.etf, row: null };
    const price = quote && Number.isFinite(quote.price) && quote.price > 0 ? quote.price : null;
    const currentPrice = quoteDates.get(sector.etf) === asOfDate ? price : null;
    // A strict trailing request may begin after the prior year's weekend or
    // holiday. Ask for a small boundary buffer when the provider supports it.
    if (asOfDate && !computeTrailingReturn(history, "1Y", currentPrice, asOfDate)
      && provider.getDetailedPriceHistory) {
      const start = new Date(`${sectorReturnTargetDate(asOfDate, "1Y")}T00:00:00Z`);
      start.setUTCDate(start.getUTCDate() - 7);
      const end = new Date(`${asOfDate}T00:00:00Z`);
      end.setUTCDate(end.getUTCDate() + 1);
      const extended = await provider.getDetailedPriceHistory(sector.etf, "", start, end, "1d").catch(() => []);
      if (extended.length > 0) history = [...history, ...extended];
    }
    const month = computeTrailingReturn(history, "1M", currentPrice, asOfDate);
    const year = computeTrailingReturn(history, "1Y", currentPrice, asOfDate);
    return {
      etf: sector.etf,
      row: {
        price,
        quoteUnavailable: price == null,
        changePercent: quote?.changePercent ?? null,
        return1M: month?.value ?? null,
        return1Y: year?.value ?? null,
        returnAsOfDate: asOfDate,
        return1MStartDate: month?.startDate ?? null,
        return1YStartDate: year?.startDate ?? null,
        currency: quote?.currency ?? "USD",
      },
    };
  }));
  // These ETFs share a market calendar. A missing observation for one fund
  // must not silently give it an earlier baseline than its peers.
  const monthStartDate = outcomes.map(({ row }) => row?.return1MStartDate).filter((date): date is string => !!date).sort().at(-1);
  const yearStartDate = outcomes.map(({ row }) => row?.return1YStartDate).filter((date): date is string => !!date).sort().at(-1);
  for (const { row } of outcomes) {
    if (!row) continue;
    if (row.return1MStartDate !== monthStartDate) { row.return1M = null; row.return1MStartDate = null; }
    if (row.return1YStartDate !== yearStartDate) { row.return1Y = null; row.return1YStartDate = null; }
  }
  return outcomes;
}

function quoteSessionDate(quote: Quote): string | null {
  const declared = quote.changeSessionDate;
  if (typeof declared === "string" && /^\d{4}-\d{2}-\d{2}$/.test(declared)
    && Number.isFinite(Date.parse(declared)) && new Date(declared).toISOString().slice(0, 10) === declared) return declared;
  if (!Number.isFinite(quote.lastUpdated) || quote.lastUpdated <= 0) return null;
  // Every instrument in these collections is a US-listed ETF. quote.price is
  // the regular-session price; prefer its declared session when supplied.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(quote.lastUpdated));
}
