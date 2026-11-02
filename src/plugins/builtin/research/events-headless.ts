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
import { buildEventRows, eventSourceNotice, CORPORATE_ACTION_COVERAGE } from "./event-model";
import { EVENT_COLUMNS, loadEventSources } from "./event-sources";
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
      return {
        rows: own.map((row) => ({ ...row })),
        ...(ended ? { notes: [ended] } : {}),
        errors: errors.length > 0 ? errors : undefined,
        metadata: { symbol, currency: data.currency, coverage: data.actions?.coverage,
          coverageNote: CORPORATE_ACTION_COVERAGE, epsBasis: EPS_BASIS_NOTE,
          actionsFetchedAt: data.actions?.fetchedAt, estimatesFetchedAt: data.estimates?.fetchedAt,
          ...(notice ? { notice: notice.text } : {}),
        },
      };
    },
  };
}

export const eventsHeadless = createEventsHeadless();
