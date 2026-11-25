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
import { buildEventRows, buildNextUp, eventSourceNotice, isFundListing, nextCatalystOf, nextCatalystQuery, CORPORATE_ACTION_COVERAGE, type NextCatalyst } from "./event-model";
import { dividendYearDetail, dividendYearLabel, dividendYears, earningsQuarters, splitMarks } from "./event-charts";
import { fetchCatalysts } from "../catalysts/client";
import { isCloudSessionRequired } from "../shared/research-cloud-session";
import { distributionAmountsDigits, formatPercentRaw } from "../../../utils/format";
import type { HeadlessBundleSection, HeadlessPaneColumn } from "../../../types/headless";
import { EVENT_COLUMNS, eventSummarySection, loadEventSources, quarterTextColumns, quarterTextRows } from "./event-sources";
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

/** The Dividends view's table: one row per year of ex-dates, newest first. */
const YEAR_TEXT_COLUMNS: HeadlessPaneColumn[] = [
  { key: "year", header: "Year" },
  { key: "paid", header: "Paid", align: "right" },
  { key: "special", header: "Special", align: "right" },
  { key: "payments", header: "Payments", align: "right" },
  { key: "change", header: "Change", align: "right" },
  { key: "detail", header: "Detail" },
];

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
      const fund = isFundListing(data.financials, data.actions);
      const notice = eventSourceNotice({ variant: "corporate-actions", symbol,
        actions: data.actions, actionsError: data.actionsError ?? null,
        estimates: fund ? null : data.estimates, estimatesError: fund ? null : data.estimatesError ?? null });
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
      const notes = ended ? [ended] : [];
      // As the pane reads: what is next, the quarters of its Earnings view and the years of its Dividends view.
      // The exports keep every event row.
      const today = listingDay(parsePublicTickerKey(symbol).exchange);
      // The next catalyst, as the Earnings view asks the calendar for it; a failed read is said, the rest stands.
      let catalyst: NextCatalyst | null = null;
      // A context without the cloud client (a test's) reads no catalysts.
      if (!fund && (ctx.apiClient as Partial<typeof ctx.apiClient> | undefined)?.getCloudCatalysts) {
        try {
          catalyst = nextCatalystOf(await fetchCatalysts(nextCatalystQuery(symbol), ctx.apiClient, ctx.signal), today);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // Signed out, as in the pane, the figure is left out: the Catalysts report says why.
          if (!isCloudSessionRequired(message)) errors.push(`Catalysts unavailable: ${message}`);
        }
      }
      const summary = buildNextUp(own, { today, fund, statedExDate: data.financials?.fundamentals?.exDividendDate, catalyst });
      const quarters = fund ? [] : earningsQuarters(own, today);
      const quarterRows = quarterTextRows(quarters);
      const years = dividendYears(data.actions?.dividends ?? [], today, splitMarks(own), data.actions?.coverage?.dividends, { includeSplitOnly: fund });
      const currency = data.actions?.currency ?? data.currency;
      const digits = Math.min(4, distributionAmountsDigits(years.flatMap((year) => (year.total == null ? [] : [year.total])), currency || "USD"));
      const yearRows = years.map((year) => ({
        year: dividendYearLabel(year),
        paid: year.total == null ? "" : `${year.total.toFixed(digits)}${currency ? ` ${currency}` : ""}`,
        special: year.special > 0 ? year.special.toFixed(digits) : "",
        payments: year.payments ? String(year.payments) : "",
        change: year.change == null ? "" : formatPercentRaw(year.change * 100),
        detail: dividendYearDetail(year),
      }));
      // The Special column only where the issuer's forms mark one, as the pane shows it.
      const yearColumns = years.some((year) => year.special > 0) ? YEAR_TEXT_COLUMNS : YEAR_TEXT_COLUMNS.filter((column) => column.key !== "special");
      const yearSection: HeadlessBundleSection = { title: "Dividends by year", columns: yearColumns, rows: yearRows };
      const sections = [...(summary.length ? [eventSummarySection(summary)] : []), ...(fund || !yearRows.length ? [] : [yearSection])];
      return {
        rows: own.map((row) => ({ ...row })),
        textColumns: fund ? yearColumns : quarterTextColumns(quarters),
        textRows: fund ? yearRows : quarterRows,
        textRowsUseRecordsWhenWindowed: true,
        ...(sections.length ? { textSections: sections } : {}),
        ...(notes.length ? { notes } : {}),
        errors: errors.length > 0 ? errors : undefined,
        metadata: { symbol, currency: data.currency, coverage: data.actions?.coverage,
          coverageNote: CORPORATE_ACTION_COVERAGE, epsBasis: EPS_BASIS_NOTE,
          actionsFetchedAt: data.actions?.fetchedAt, estimatesFetchedAt: data.estimates?.fetchedAt,
          ...(summary.length ? { nextUp: summary } : {}),
          ...(notice ? { notice: notice.text } : {}),
        },
      };
    },
  };
}

export const eventsHeadless = createEventsHeadless();
