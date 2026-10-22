import { PERIOD_BASE_MAX_GAP_DAYS } from "../../../market-data/market/period-return";
import type { DataProvider } from "../../../types/data-provider";
import type { PricePoint, Quote } from "../../../types/financials";
import { logFailure } from "../../../utils/log-failure";
import type { SectorDef } from "./sector-data";
import { getCompletedRegularSessionDisplay, getRegularSessionDisplay } from "../../../market-data/market/status";
import {
  computeTrailingReturn,
  historySessionBefore,
  latestHistoryDate,
  sectorExtendedFields,
  sectorReturnTargetDate,
  sectorQuoteSessionDate,
  sectorReturnStartDate,
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
    ).catch(logFailure("sectors", "Sector quote batch failed", []));
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
    await provider.getPriceHistory(sector.etf, "", "1Y").catch(logFailure("sectors", "Sector price history failed", [])),
  ] as const)));
  // The quotes as sent carry any pre-market or after-hours print, for its own column.
  const sentQuotes = new Map(quotes);
  // Pre-market quotes whose last completed session nothing confirms.
  const unconfirmed = new Set<string>();
  for (const [symbol, quote] of quotes) {
    if (!quote) continue;
    const completed = completedSessionQuote(quote, histories.get(symbol) ?? []);
    quotes.set(symbol, completed.quote);
    if (!completed.confirmed) unconfirmed.add(symbol);
  }
  const quoteDates = new Map([...quotes].map(([symbol, quote]) => [symbol, quote ? quoteSessionDate(quote) : null]));
  // The shared session is the newest one the funds report. A pre-market quote
  // that cannot say which session it follows reports none: it must not pull
  // every other fund onto a session that has not traded, unless no fund can say.
  const datedQuotes = [...quoteDates].filter((entry): entry is [string, string] => entry[1] != null);
  const confirmedQuotes = datedQuotes.filter(([symbol]) => !unconfirmed.has(symbol));
  const asOfDate = [...(confirmedQuotes.length > 0 ? confirmedQuotes : datedQuotes).map(([, date]) => date),
    ...[...histories.values()].map(latestHistoryDate)]
    .filter((date): date is string => date != null).sort().at(-1) ?? null;

  const outcomes = await Promise.all(sectors.map(async (sector) => {
    let history: PricePoint[] = histories.get(sector.etf) ?? [];
    const quote = quotes.get(sector.etf) ?? null;
    if (!quote && history.length === 0) return { etf: sector.etf, row: null };
    // Price and 1D are the regular session, as `ticker` reads them: after the close
    // its close and move, with an extended print in its own column.
    const headline = getRegularSessionDisplay(quote);
    const lastReportedPrice = headline && Number.isFinite(headline.price) && headline.price > 0 ? headline.price : null;
    const sessionDate = quoteDates.get(sector.etf) ?? null;
    // A quote flagged stale is not current for the session in progress, which
    // is all the pre-market and after-hours ask of a fund that has not printed
    // since. The close of a completed session stays that session's close.
    const completedClose = quote != null && getCompletedRegularSessionDisplay(quote) != null;
    const priceIssue = !quote || lastReportedPrice == null ? "quote unavailable"
      : !sessionDate ? "quote session unknown"
      : quote.stale && !completedClose ? `stale quote from ${sessionDate}`
      : sessionDate !== asOfDate
        ? unconfirmed.has(sector.etf) ? "pre-market quote without a confirmed last close"
          : `quote from ${sessionDate}; shared session is ${asOfDate}`
      : null;
    const price = priceIssue ? null : lastReportedPrice;
    const changePercent = price != null && Number.isFinite(headline?.changePercent) ? headline!.changePercent! : null;
    const quoteIssue = priceIssue ?? (changePercent == null ? "1D change unavailable" : null);
    // A strict trailing request may begin after the prior year's weekend or
    // holiday. Ask for a small boundary buffer when the provider supports it.
    if (asOfDate && computeTrailingReturn(history, "1Y", price, asOfDate)?.value == null
      && provider.getDetailedPriceHistory) {
      const start = new Date(`${sectorReturnTargetDate(asOfDate, "1Y")}T00:00:00Z`);
      start.setUTCDate(start.getUTCDate() - PERIOD_BASE_MAX_GAP_DAYS);
      const end = new Date(`${asOfDate}T00:00:00Z`);
      end.setUTCDate(end.getUTCDate() + 1);
      const extended = await provider.getDetailedPriceHistory(sector.etf, "", start, end, "1d").catch(logFailure("sectors", "Sector extended price history failed", []));
      if (extended.length > 0) {
        history = [...history, ...extended];
        histories.set(sector.etf, history);
      }
    }
    const month = computeTrailingReturn(history, "1M", price, asOfDate);
    const year = computeTrailingReturn(history, "1Y", price, asOfDate);
    return {
      etf: sector.etf,
      row: {
        price,
        quoteUnavailable: price == null,
        quoteSessionDate: sessionDate,
        quoteIssue,
        lastReportedPrice,
        quoteUpdatedAt: quote && Number.isFinite(quote.lastUpdated) ? quote.lastUpdated : null,
        quoteDataSource: quote?.dataSource,
        changePercent,
        // A stale quote's extended print is not a current one.
        ...sectorExtendedFields(price == null || quote?.stale ? null : sentQuotes.get(sector.etf)),
        return1M: month?.value ?? null,
        return1Y: year?.value ?? null,
        returnAsOfDate: asOfDate,
        return1MStartDate: month?.startDate ?? null,
        return1YStartDate: year?.startDate ?? null,
        returnIntegrity: {
          ...(month?.integrity ? { "1M": month.integrity } : {}),
          ...(year?.integrity ? { "1Y": year.integrity } : {}),
        },
        currency: quote?.currency ?? "USD",
      },
    };
  }));
  // These ETFs share a market calendar. A missing observation for one fund
  // must not silently give it an earlier baseline than its peers. Use every
  // reported baseline, independently of whether that fund has an ending price.
  const sharedStartDate = (range: "1M" | "1Y") => [...histories.values()]
    .map((history) => sectorReturnStartDate(history, range, asOfDate))
    .filter((date): date is string => !!date).sort().at(-1);
  const monthStartDate = sharedStartDate("1M");
  const yearStartDate = sharedStartDate("1Y");
  for (const { row } of outcomes) {
    if (!row) continue;
    if (row.return1MStartDate !== monthStartDate) { row.return1M = null; row.return1MStartDate = null; }
    if (row.return1YStartDate !== yearStartDate) { row.return1Y = null; row.return1YStartDate = null; }
  }
  return outcomes;
}

/**
 * Before the open a pre-market quote dates itself to a session that has not
 * traded yet, while funds without a print still report yesterday. Rank every
 * fund on the last completed session. A quote that carries that close
 * (`regularClose`, as Gloom Cloud sends it) already says which session it is
 * (sectorQuoteSessionDate). One that does not takes it from its history,
 * confirmed by the quote's own previous close; without that confirmation the
 * session is unknown (`confirmed: false`).
 */
function completedSessionQuote(quote: Quote, history: readonly PricePoint[]): { quote: Quote; confirmed: boolean } {
  if (quote.marketState !== "PRE" || getCompletedRegularSessionDisplay(quote)) return { quote, confirmed: true };
  const sessionDate = quoteSessionDate(quote);
  const latestDate = latestHistoryDate(history);
  if (!sessionDate) return { quote, confirmed: true };
  if (latestDate && sessionDate <= latestDate) return { quote, confirmed: true };
  const completed = latestDate ? historySessionBefore(history, sessionDate) : null;
  const previousClose = quote.previousClose;
  if (!completed || previousClose == null || !(previousClose > 0)
    || Math.abs(completed.close / previousClose - 1) > 0.001) return { quote, confirmed: false };
  return {
    confirmed: true,
    quote: {
      ...quote,
      price: completed.close,
      change: completed.close * completed.changePercent / (100 + completed.changePercent),
      changePercent: completed.changePercent,
      changeSessionDate: completed.date,
    },
  };
}

function quoteSessionDate(quote: Quote): string | null {
  return sectorQuoteSessionDate(quote);
}
