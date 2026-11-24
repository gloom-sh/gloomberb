import type { DataProvider } from "../../../types/data-provider";
import type {
  AnalystResearchData,
  CorporateActionsData,
  TickerFinancials,
} from "../../../types/financials";
import type {
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import { buildEventRows, buildEventSummary, eventSourceNotice, isFundListing, recentDividends, CORPORATE_ACTION_COVERAGE } from "./event-model";
import { EVENT_COLUMNS, EVENT_TEXT_COLUMNS, eventSummarySection, loadEventSources } from "./event-sources";
import { listingDay } from "../shared/earnings-calendar";
import { REPORTED_DATA } from "../shared/report-freshness";
import { EPS_BASIS_NOTE } from "../shared/earnings-report";
import { loadNoQuoteLastTraded, noQuoteLastTradeNote, otherListingProfile } from "../../../tickers/listing-fate";
import { isUsSymbolVenue } from "../../../tickers/ticker-changes";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import type { EventStatus } from "./event-model";

interface EventHeadlessData {
  actions: CorporateActionsData | null;
  estimates: AnalystResearchData | null;
  financials: TickerFinancials | null;
  currency: string;
  actionsError?: string | null;
  estimatesError?: string | null;
  financialsError?: string | null;
}

/** The rows drawn from the research served under a symbol (its reports and estimates), not from its own corporate actions. */
const RESEARCH_EVENTS: ReadonlySet<EventStatus> = new Set(["Earnings", "Q Est", "FY Est", "TTM"]);

export interface EventsHeadlessDependencies {
  load(
    args: HeadlessPaneLoadArgs,
    symbol: string,
    provider: DataProvider,
  ): Promise<EventHeadlessData>;
}

const defaultDependencies: EventsHeadlessDependencies = {
  async load(_args, symbol, provider) {
    const sources = await loadEventSources(provider, symbol);
    return {
      ...sources,
      actionsError: provider.getCorporateActions ? sources.actionsError : "Corporate actions source unavailable",
      estimatesError: provider.getAnalystResearch ? sources.estimatesError : "Analyst estimates source unavailable",
    };
  },
};

export function createEventsHeadless(
  dependencies: EventsHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    freshness: { ...REPORTED_DATA, basis: "corporate actions", oldest: null },
    argument: {
      kind: "ticker",
      placeholder: "ticker",
      description: "Ticker whose corporate actions and estimates should be returned.",
    },
    options: [],
    columns: EVENT_COLUMNS,
    describe: (args) => `Corporate Actions | ${String(args.argument)}`,
    async load(args, ctx) {
      const symbol = args.symbols[0]!;
      const data = await dependencies.load(args, symbol, ctx.marketData);
      const notice = eventSourceNotice({ variant: "corporate-actions", symbol,
        actions: data.actions, actionsError: data.actionsError ?? null,
        estimates: data.estimates, estimatesError: data.estimatesError ?? null });
      const errors = [notice?.failed ? notice.text : null,
        data.financialsError ? `Financial statements unavailable: ${data.financialsError}` : null,
      ].filter((error): error is string => !!error);
      // A symbol with no quote whose listing stopped trading says when it last traded. The issuer's own events after
      // that stay (a cash-out, a liquidating distribution); only where the research served under the symbol is shown
      // to be another listing's (STPP: a fund abroad's profile) are the reports and estimates after it dropped.
      const lastTrade = data.financials?.quote ? null : await loadNoQuoteLastTraded({ symbol }, ctx.marketData);
      const other = lastTrade ? otherListingProfile(data.financials?.profile, { usLine: isUsSymbolVenue(parsePublicTickerKey(symbol).exchange) }) : null;
      const rows = buildEventRows(data.actions, data.estimates, data.financials, data.currency);
      const own = lastTrade && other
        ? rows.filter((row) => !RESEARCH_EVENTS.has(row.status) || row.date.slice(0, 10) <= lastTrade.date) : rows;
      const hidden = rows.length - own.length;
      const ended = lastTrade ? `${noQuoteLastTradeNote(symbol, lastTrade)}.${hidden > 0
        ? ` ${hidden} later ${hidden === 1 ? "report is" : "reports are"} another listing's (${other}), not shown.` : ""}` : null;
      // The pane's list: the last few years of dividends, the rest DVD's.
      const { earlier, before } = recentDividends(data.actions?.dividends ?? []);
      const toDvd = earlier > 0 ? `${earlier} earlier ${earlier === 1 ? "dividend" : "dividends"}, ex ${before} and before, are in DVD: gloom fn DVD ${symbol}` : null;
      const notes = [ended, toDvd].filter((note): note is string => !!note);
      // The figures over the pane's table, under the rows here.
      const summary = buildEventSummary(own, { today: listingDay(parsePublicTickerKey(symbol).exchange), variant: "corporate-actions",
        fund: isFundListing(data.financials), statedExDate: data.financials?.fundamentals?.exDividendDate });
      return {
        rows: own.map((row) => ({ ...row })),
        textColumns: EVENT_TEXT_COLUMNS,
        ...(summary.length ? { textSections: [eventSummarySection(summary)] } : {}),
        ...(notes.length ? { notes } : {}),
        errors: errors.length > 0 ? errors : undefined,
        metadata: { symbol, currency: data.currency, coverage: data.actions?.coverage,
          coverageNote: CORPORATE_ACTION_COVERAGE, epsBasis: EPS_BASIS_NOTE,
          actionsFetchedAt: data.actions?.fetchedAt, estimatesFetchedAt: data.estimates?.fetchedAt,
          ...(summary.length ? { nextUp: summary } : {}),
          ...(earlier > 0 ? { earlierDividends: { count: earlier, latestExDate: before } } : {}),
          ...(notice ? { notice: notice.text } : {}),
        },
      };
    },
  };
}

export const eventsHeadless = createEventsHeadless();
