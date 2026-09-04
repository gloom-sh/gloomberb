import type { DataProvider } from "../../../types/data-provider";
import type { PricePoint, Quote } from "../../../types/financials";
import type { SectorDef } from "./sector-data";
import {
  computeTrailingReturn,
  latestHistoryClose,
  ONE_MONTH_DAYS,
  ONE_YEAR_DAYS,
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
  } else {
    await Promise.all(sectors.map(async (sector) => {
      try {
        quotes.set(sector.etf, await provider.getQuote(sector.etf, ""));
      } catch {
        quotes.set(sector.etf, null);
      }
    }));
  }

  return Promise.all(sectors.map(async (sector) => {
    const history: PricePoint[] = await provider.getPriceHistory(sector.etf, "", "1Y")
      .catch(() => []);
    const quote = quotes.get(sector.etf) ?? null;
    if (!quote && history.length === 0) return { etf: sector.etf, row: null };
    const price = quote?.price ?? latestHistoryClose(history);
    return {
      etf: sector.etf,
      row: {
        price,
        changePercent: quote?.changePercent ?? null,
        return1M: computeTrailingReturn(history, ONE_MONTH_DAYS, price),
        return1Y: computeTrailingReturn(history, ONE_YEAR_DAYS, price),
        currency: quote?.currency ?? "USD",
      },
    };
  }));
}
