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
import type { AnalystEstimateRecord } from "../../../types/financials";
import type { HeadlessBundleSection, HeadlessPaneColumn } from "../../../types/headless";
import { MISSING_VALUE, formatPercent } from "../../../utils/format";
import { isNotMeaningful, NOT_MEANINGFUL_TEXT } from "../../../utils/growth";
import { buildEarningsHeader, buildEventRows, estimateRate, eventSourceNotice, formatEventMetric, forwardEstimates, isFundListing, type EventRow } from "./event-model";
import { earningsQuarters } from "./event-charts";
import { EARNINGS_ESTIMATE_COLUMNS, eventSummarySection, loadEventSources, quarterTextColumns, quarterTextRows } from "./event-sources";
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

/** The Estimates view's table, as the text report prints it: the quarters ahead, then the years, nearest first. */
const ESTIMATE_TEXT_COLUMNS: HeadlessPaneColumn[] = [
  { key: "period", header: "Period" },
  { key: "ends", header: "Ends" },
  { key: "eps", header: "EPS", align: "right" },
  { key: "epsLow", header: "EPS low", align: "right" },
  { key: "epsHigh", header: "EPS high", align: "right" },
  { key: "epsGrowth", header: "EPS y/y", align: "right" },
  { key: "epsAnalysts", header: "EPS ests", align: "right" },
  { key: "revenue", header: "Revenue", align: "right" },
  { key: "revenueLow", header: "Rev low", align: "right" },
  { key: "revenueHigh", header: "Rev high", align: "right" },
  { key: "revenueGrowth", header: "Rev y/y", align: "right" },
  { key: "revenueAnalysts", header: "Rev ests", align: "right" },
];

function growthText(estimate: AnalystEstimateRecord | undefined): string {
  const rate = estimateRate(estimate);
  return isNotMeaningful(rate) ? NOT_MEANINGFUL_TEXT : rate == null ? MISSING_VALUE : formatPercent(rate);
}

function estimateTextRow(row: EventRow): Record<string, string> {
  const metric = (estimate: AnalystEstimateRecord | undefined, value: number | undefined, kind: "eps" | "revenue") =>
    formatEventMetric(value, estimate?.currency, kind);
  const { eps, revenue } = row.estimateInputs ?? {};
  return {
    period: row.period, ends: row.date,
    eps: metric(eps, eps?.average, "eps"), epsLow: metric(eps, eps?.low, "eps"), epsHigh: metric(eps, eps?.high, "eps"),
    epsGrowth: growthText(eps), epsAnalysts: eps?.analysts == null ? MISSING_VALUE : String(eps.analysts),
    revenue: metric(revenue, revenue?.average, "revenue"), revenueLow: metric(revenue, revenue?.low, "revenue"),
    revenueHigh: metric(revenue, revenue?.high, "revenue"), revenueGrowth: growthText(revenue),
    revenueAnalysts: revenue?.analysts == null ? MISSING_VALUE : String(revenue.analysts),
  };
}

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
  // The figures over the pane's views: the next report with its consensus, and the trailing twelve months.
  const symbol = args.symbols[0] ?? String(args.argument ?? "");
  const today = listingDay(parsePublicTickerKey(symbol).exchange);
  const fund = isFundListing(sources.financials, sources.actions);
  const summary = buildEarningsHeader(all, { today, fund });
  const rows = matching.slice(0, limit).map((row) => ({ ...row,
    ...(row.status === "Q Est" || row.status === "FY Est" ? {
      epsBasis: row.estimateInputs?.eps?.epsBasis === "gaap" ? "GAAP" : row.estimateInputs?.eps?.epsBasis === "adjusted" ? "adjusted" : "unknown",
    } : {}),
  }));
  // As the pane reads: its Estimates view (quarters, then years) and its Reported view (EVT's quarters). The exports
  // keep every row of the kind asked for.
  const { quarters, years } = forwardEstimates(all);
  const estimateRows = [...quarters, ...years].map(estimateTextRow).slice(0, limit);
  const listedQuarters = fund ? [] : earningsQuarters(all, today).slice(0, limit);
  const quarterRows = quarterTextRows(listedQuarters);
  const quarterColumns = quarterTextColumns(listedQuarters);
  const quarterSection: HeadlessBundleSection = { title: "Reported quarters", columns: quarterColumns, rows: quarterRows };
  // `--view` prints one of the pane's views under Next up, as `shot` opens on it; without it, `--kind` says which.
  const view = args.options.view === "estimates" || args.options.view === "reported" ? args.options.view : null;
  const reportedText = view ? view === "reported" : kind === "reported";
  const sections = [...(summary.length ? [eventSummarySection(summary)] : []), ...(!view && kind === "all" && quarterRows.length ? [quarterSection] : [])];
  const notice = eventSourceNotice({ variant: "earnings-estimates", symbol: args.symbols[0] ?? String(args.argument ?? ""),
    actions: sources.actions, estimates: fund ? null : sources.estimates,
    actionsError: sources.actions ? null : "Source unavailable", estimatesError: fund || sources.estimates ? null : "Source unavailable",
  });
  const errors = [...(sources.errors ?? []), ...(notice?.failed ? [notice.text] : [])];
  const unmatchedReportedPeriods = matching.filter((row) => row.earningsState === "reported" && !row.fiscalPeriodEnd).map((row) => row.date);

  return {
    columns: ESTIMATE_COLUMNS,
    rows,
    textColumns: reportedText ? quarterColumns : ESTIMATE_TEXT_COLUMNS,
    textRows: reportedText ? quarterRows : estimateRows,
    ...(sections.length ? { textSections: sections } : {}),
    errors: errors.length ? errors : undefined,
    metadata: {
      // When Gloom Cloud read the figures (the newer of the earnings rows' and the estimates' reads): the export's as_of.
      asOf: newestRead(sources.actions?.fetchedAt, sources.estimates?.fetchedAt),
      currency: sources.currency,
      kind,
      ...(view ? { view } : {}),
      total: matching.length,
      returned: rows.length,
      truncated: rows.length < matching.length,
      coverageNote: notice?.text,
      epsBasis: `Estimate basis is unknown unless the estimate source explicitly identifies GAAP or adjusted; never assume it matches a reported quarter. ${EPS_BASIS_NOTE} The TTM row's EPS (EPS TTM in Next up) is the GAAP diluted trailing figure ticker shows as EPS (TTM): the last four filed quarters', or Gloom Cloud's TTM (named so) when they give none, or the four statement quarters' diluted EPS when neither is there; reported quarters of different bases are never summed, and the row adds an adjusted sum only when all four quarters are adjusted.`,
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
        // Not `--kind`, which filters the rows every format lists: this is which of the pane's two views it shows.
        key: "view",
        settingKey: "view",
        description: "The pane's view: estimates, the quarters and years ahead, or reported, the reported quarters charted over their table. The text report prints that view's table under Next up; --kind still picks the rows CSV and JSON list.",
        type: "enum",
        values: [
          { value: "estimates" },
          { value: "reported" },
        ],
        example: "--view reported",
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
