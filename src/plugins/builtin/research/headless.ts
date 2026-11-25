import type {
  AnalystResearchData,
  CorporateActionsData,
  TickerFinancials,
} from "../../../types/financials";
import type {
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
  HeadlessRowsResult,
} from "../../../types/plugin";
import { buildEventRows, buildEventSummary, eventSourceNotice, isFundListing, type EventRow } from "./event-model";
import { EARNINGS_ESTIMATE_COLUMNS, eventSummarySection, loadEventSources } from "./event-sources";
import { listingDay } from "../shared/earnings-calendar";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import { REPORTED_DATA } from "../shared/report-freshness";
import { EPS_BASIS_NOTE } from "../shared/earnings-report";
import { REPORT_FILTER, REPORT_ROWS } from "../shared/headless-options";

export interface EarningsEstimateSources {
  actions: CorporateActionsData | null;
  estimates: AnalystResearchData | null;
  financials: TickerFinancials | null;
  currency: string;
  errors?: string[];
}

export interface EarningsEstimatesHeadlessDependencies {
  loadSources(
    symbol: string,
    context: HeadlessPaneContext,
  ): Promise<EarningsEstimateSources>;
}

const ESTIMATE_COLUMNS = [...EARNINGS_ESTIMATE_COLUMNS, { key: "epsBasis", header: "EPS basis" }];

const defaultDependencies: EarningsEstimatesHeadlessDependencies = {
  async loadSources(symbol, context) {
    const { actions, estimates, financials, currency, ...failures } = await loadEventSources(context.marketData, symbol);
    const errors = [
      failures.actionsError === null ? null : `corporate actions: ${failures.actionsError}`,
      failures.estimatesError === null ? null : `analyst estimates: ${failures.estimatesError}`,
      failures.financialsError === null ? null : `financials: ${failures.financialsError}`,
    ].filter((error): error is string => error !== null);
    if (!actions && !estimates && !financials && errors.length > 0) {
      throw new Error(errors.join("; "));
    }
    return { actions, estimates, financials, currency, errors };
  },
};

function matchesKind(row: EventRow, kind: string): boolean {
  if (kind === "all") return ["Earnings", "Q Est", "FY Est", "TTM"].includes(row.status);
  if (kind === "estimates") return row.status === "Q Est" || row.status === "FY Est";
  return row.status === "Earnings" && row.earningsState === "reported";
}

/** The newest of the sources' read times (ISO instants); null when none says. */
function newestRead(...times: Array<string | undefined>): string | null {
  const read = times.filter((time): time is string => !!time && Number.isFinite(Date.parse(time)));
  return read.length ? read.reduce((newest, time) => (Date.parse(time) > Date.parse(newest) ? time : newest)) : null;
}

function projectEarningsEstimatesHeadless(
  sources: EarningsEstimateSources,
  args: HeadlessPaneLoadArgs,
): HeadlessRowsResult {
  const kind = String(args.options.kind ?? "all");
  const limit = Number(args.options.limit ?? 50);
  const all = buildEventRows(
    sources.actions,
    sources.estimates,
    sources.financials,
    sources.currency,
  );
  const matching = all.filter((row) => matchesKind(row, kind));
  // The figures over the pane's table: the next report with its consensus and the last surprise.
  const symbol = args.symbols[0] ?? String(args.argument ?? "");
  const summary = buildEventSummary(all.filter((row) => matchesKind(row, "all")), {
    today: listingDay(parsePublicTickerKey(symbol).exchange), fund: isFundListing(sources.financials),
  });
  const rows = matching.slice(0, limit).map((row) => ({ ...row,
    ...(row.status === "Q Est" || row.status === "FY Est" ? {
      epsBasis: row.estimateInputs?.eps?.epsBasis === "gaap" ? "GAAP" : row.estimateInputs?.eps?.epsBasis === "adjusted" ? "adjusted" : "unknown",
    } : {}),
  }));
  const notice = eventSourceNotice({ variant: "earnings-estimates", symbol: args.symbols[0] ?? String(args.argument ?? ""),
    actions: sources.actions, estimates: sources.estimates,
    actionsError: sources.actions ? null : "Source unavailable", estimatesError: sources.estimates ? null : "Source unavailable",
  });
  const errors = [...(sources.errors ?? []), ...(notice?.failed ? [notice.text] : [])];
  const unmatchedReportedPeriods = matching.filter((row) => row.earningsState === "reported" && !row.fiscalPeriodEnd).map((row) => row.date);

  return {
    columns: ESTIMATE_COLUMNS,
    rows,
    ...(summary.length ? { textSections: [eventSummarySection(summary)] } : {}),
    errors: errors.length ? errors : undefined,
    metadata: {
      // When Gloom Cloud read the figures (the newer of the earnings rows' and the estimates' reads): the export's as_of.
      asOf: newestRead(sources.actions?.fetchedAt, sources.estimates?.fetchedAt),
      currency: sources.currency,
      kind,
      total: matching.length,
      returned: rows.length,
      truncated: rows.length < matching.length,
      coverageNote: notice?.text,
      epsBasis: `Estimate basis is unknown unless the estimate source explicitly identifies GAAP or adjusted; never assume it matches a reported quarter. ${EPS_BASIS_NOTE} The TTM row's EPS is the GAAP diluted trailing figure ticker shows as EPS (TTM): the last four filed quarters', or Gloom Cloud's TTM (named so) when they give none, or the four statement quarters' diluted EPS when neither is there; reported quarters of different bases are never summed, and the row adds an adjusted sum only when all four quarters are adjusted.`,
      dateNote: "Fiscal period dates are not announcement dates. Revenue is attached only to an identified statement period.",
      ...(summary.length ? { nextUp: summary } : {}),
      unmatchedReportedPeriods,
    },
  };
}

export function createEarningsEstimatesHeadless(
  dependencies: EarningsEstimatesHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    freshness: { ...REPORTED_DATA, basis: "estimates and reported earnings", oldest: null },
    argument: {
      kind: "ticker",
      placeholder: "ticker",
      description: "Company symbol.",
    },
    options: [
      {
        key: "kind",
        shot: REPORT_FILTER,
        description: "Estimate or reported rows to include.",
        type: "enum",
        values: [
          { value: "all" },
          { value: "estimates" },
          { value: "reported" },
        ],
        defaultValue: "all",
      },
      {
        key: "limit",
        shot: REPORT_ROWS,
        description: "Maximum rows to return.",
        type: "integer",
        defaultValue: 50,
        minimum: 1,
        maximum: 200,
      },
    ],
    columns: ESTIMATE_COLUMNS,
    describe: (args) => `Earnings Estimates | ${String(args.argument)}`,
    async load(args, context) {
      return projectEarningsEstimatesHeadless(
        await dependencies.loadSources(String(args.argument), context),
        args,
      );
    },
  };
}

export const earningsEstimatesHeadless = createEarningsEstimatesHeadless();
