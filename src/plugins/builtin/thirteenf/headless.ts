import type {
  HeadlessPaneColumn,
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import { normalizeCik } from "./api";
import { buildFundOverlap } from "./overlap";
import { loadCrowding, loadTickerHoldings } from "./signals";
import {
  loadBrowserRows,
  loadFundDetail,
  type BrowserLoadResult,
} from "./data";
import {
  DEFAULT_BROWSER_SORT,
  DEFAULT_HOLDING_SORT,
  DEFAULT_TIMELINE_SORT,
  buildFundHoldingRows,
  buildTimelineRows,
  inferBrowserTabFromQuery,
  hasComparable13FQuarter,
  THIRTEENF_OPTIONS_NOTE,
  isCikQuery,
  positionType,
  sortBrowserRows,
  sortHoldingRows,
  sortTimelineRows,
} from "./model";
import {
  actionLabel,
  formatChangeShares,
  formatMoneyCompact,
  formatPercentMaybe,
  formatRawPercentMaybe,
  formatShares,
  formatShortDate,
  formatWeightMaybe,
} from "./format";
import type {
  FundDetailData,
  ThirteenFBrowserTab,
} from "./types";

const numberOrNull = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const money = (value: unknown) => formatMoneyCompact(numberOrNull(value));
const weight = (value: unknown) => formatWeightMaybe(numberOrNull(value));
const shares = (value: unknown) => formatShares(numberOrNull(value));
const weightPoints = (value: unknown) => {
  const change = numberOrNull(value);
  return change == null ? "--" : `${change > 0 ? "+" : ""}${(change * 100).toFixed(2)}pp`;
};

const BROWSER_COLUMNS: HeadlessPaneColumn[] = [
  { key: "name", header: "Fund" },
  { key: "cik", header: "CIK" },
  { key: "periodOfReport", header: "Period" },
  {
    key: "estQuarterReturn",
    header: "Est 13F",
    align: "right",
    format: (value) => formatRawPercentMaybe(value == null ? null : Number(value)),
  },
  {
    key: "tableValueTotal",
    header: "Value",
    align: "right",
    format: (value) => formatMoneyCompact(value == null ? null : Number(value)),
  },
  { key: "tableEntryTotal", header: "Rows", align: "right" },
  {
    key: "filedAsOfDate",
    header: "Filed",
    format: (value) => formatShortDate(typeof value === "string" ? value : null),
  },
];

const HOLDING_COLUMNS: HeadlessPaneColumn[] = [
  { key: "ticker", header: "Ticker" },
  { key: "type", header: "Type" },
  { key: "issuer", header: "Issuer" },
  {
    key: "value",
    header: "Value",
    align: "right",
    format: (value) => formatMoneyCompact(value == null ? null : Number(value)),
  },
  {
    key: "estimatedPnl",
    header: "Est P&L",
    align: "right",
    format: (value) => formatMoneyCompact(value == null ? null : Number(value)),
  },
  {
    key: "weight",
    header: "13F %",
    description: "Share of the filing's reported value, including underlying notional for options; not portfolio allocation.",
    align: "right",
    format: weight,
  },
  {
    key: "shares",
    header: "Shares",
    align: "right",
    format: (value) => formatShares(value == null ? null : Number(value)),
  },
  {
    key: "sharesChange",
    header: "QoQ",
    align: "right",
    format: (value) => formatChangeShares(value == null ? null : Number(value)),
  },
  { key: "actionLabel", header: "Action" },
];

const FILING_COLUMNS: HeadlessPaneColumn[] = [
  { key: "periodOfReport", header: "Period" },
  {
    key: "filedAsOfDate",
    header: "Filed",
    format: (value) => formatShortDate(typeof value === "string" ? value : null),
  },
  {
    key: "tableValueTotal",
    header: "Value",
    align: "right",
    format: (value) => formatMoneyCompact(value == null ? null : Number(value)),
  },
  { key: "tableEntryTotal", header: "Rows", align: "right" },
  {
    key: "valueChangePercent",
    header: "Value%",
    align: "right",
    format: (value) => formatPercentMaybe(value == null ? null : Number(value)),
  },
  { key: "submissionType", header: "Form" },
  { key: "amendmentType", header: "Amendment" },
];

type HeadlessThirteenFView =
  | "overlap"
  | "crowding"
  | "ticker-holdings"
  | "auto"
  | "performance"
  | "funds"
  | "by-ticker"
  | "latest"
  | "holdings"
  | "filings";

export interface ThirteenFHeadlessDependencies {
  loadBrowser(
    tab: ThirteenFBrowserTab,
    query: string,
    limit: number,
    args: HeadlessPaneLoadArgs,
    ctx: HeadlessPaneContext,
  ): Promise<BrowserLoadResult>;
  loadDetail(
    cik: string,
    name: string,
    args: HeadlessPaneLoadArgs,
    ctx: HeadlessPaneContext,
  ): Promise<FundDetailData>;
}

const defaultDependencies: ThirteenFHeadlessDependencies = {
  loadBrowser: (tab, query, limit, _args, ctx) => loadBrowserRows(
    tab,
    query,
    ctx.signal,
    { limit },
  ),
  loadDetail: (cik, name, _args, ctx) => loadFundDetail(cik, name, ctx.signal),
};

function browserTab(view: HeadlessThirteenFView, query: string): ThirteenFBrowserTab {
  if (view === "performance" || view === "funds" || view === "latest") return view;
  if (view === "by-ticker") return "byTicker";
  return inferBrowserTabFromQuery(query);
}

async function resolveFund(
  query: string,
  args: HeadlessPaneLoadArgs,
  ctx: HeadlessPaneContext,
  dependencies: ThirteenFHeadlessDependencies,
): Promise<{ cik: string; name: string }> {
  if (!query) throw new Error("13F holdings and filings require a fund name or CIK.");
  if (isCikQuery(query)) return { cik: normalizeCik(query), name: query };
  // A small output limit must not hide other matching managers during lookup.
  const result = await dependencies.loadBrowser("funds", query, 25, args, ctx);
  const candidates = [...new Map(result.rows.map((row) => [row.cik, row])).values()];
  const exact = candidates.filter((row) => row.name.toLocaleLowerCase() === query.toLocaleLowerCase());
  const fund = exact.length === 1 ? exact[0]
    : candidates.length === 1 && !result.hasMore ? candidates[0] : undefined;
  if (candidates.length === 0) throw new Error(`No 13F fund found for "${query}".`);
  if (!fund) {
    const choices = candidates.slice(0, 5).map((row) => `${row.name} (${row.cik})`).join("; ");
    throw new Error(`Ambiguous 13F fund "${query}". Use an exact fund name or CIK: ${choices}.`);
  }
  return { cik: fund.cik, name: fund.name };
}

export function createThirteenFHeadless(
  dependencies: ThirteenFHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    argument: {
      kind: "free-text",
      placeholder: "fund, ticker, or CIK",
      description: "Optional fund name, ticker, CIK, or latest keyword.",
      optional: true,
    },
    options: [
      { key: "rank", description: "Crowding order.", type: "enum", values: [{ value: "new" }, { value: "exits" }, { value: "increases" }, { value: "decreases" }], defaultValue: "new" },
      { key: "compare", description: "Second fund name or CIK for overlap.", type: "string" },
      { key: "offset", description: "Fund offset for ticker-holdings.", type: "integer", defaultValue: 0, minimum: 0, maximum: 100000 },
      {
        key: "view",
        description: "Fund browser mode or detail tab.",
        type: "enum",
        values: [
          { value: "auto" },
          { value: "crowding" },
          { value: "overlap" },
          { value: "ticker-holdings" },
          { value: "performance" },
          { value: "funds" },
          { value: "by-ticker", aliases: ["ticker", "byTicker"] },
          { value: "latest" },
          { value: "holdings" },
          { value: "filings" },
        ],
        defaultValue: "auto",
      },
      {
        key: "limit",
        aliases: ["count", "rows"],
        description: "Maximum rows.",
        type: "integer",
        defaultValue: 50,
        minimum: 1,
        maximum: 200,
      },
    ],
    describe: (args) => `13F Funds | ${String(args.options.view)}`,
    async load(args, ctx) {
      const query = typeof args.argument === "string" ? args.argument.trim() : "";
      const requestedView = String(args.options.view) as HeadlessThirteenFView;
      const view = requestedView === "auto" && isCikQuery(query) ? "holdings" : requestedView;
      const limit = Number(args.options.limit);
      if (view === "overlap") {
        const fund = await resolveFund(query, args, ctx, dependencies);
        const other = await resolveFund(String(args.options.compare ?? ""), args, ctx, dependencies);
        const [first, second] = await Promise.all([dependencies.loadDetail(fund.cik, fund.name, args, ctx), dependencies.loadDetail(other.cik, other.name, args, ctx)]);
        const samePeriod = !!first.latestForm && first.latestForm.periodOfReport === second.latestForm?.periodOfReport;
        const rows = buildFundOverlap(first, second);
        return { columns: [{ key: "ticker", header: "Ticker" }, { key: "type", header: "Type" }, { key: "issuer", header: "Issuer" }, { key: "weight", header: "First weight", align: "right", format: weight }, { key: "comparedWeight", header: "Second weight", align: "right", format: weight }], rows: rows.slice(0, limit).map(row => ({ ...row })), errors: [...(first.warnings ?? []), ...(second.warnings ?? []), ...(!samePeriod ? ["The funds have different latest reporting quarters."] : [])], metadata: { firstFund: first.name, secondFund: second.name, firstPeriod: first.latestForm?.periodOfReport ?? null, secondPeriod: second.latestForm?.periodOfReport ?? null, truncated: rows.length > limit } };
      }
      if (view === "crowding") {
        const { rows: sourceRows, ...metadata } = await loadCrowding(ctx.signal);
        const rank = String(args.options.rank ?? "new");
        const rows = [...sourceRows].sort((left, right) => {
          if (rank === "new") return right.newCount - left.newCount;
          if (rank === "exits") return right.exitCount - left.exitCount;
          if (left.weightChange == null) return right.weightChange == null ? 0 : 1;
          if (right.weightChange == null) return -1;
          return (left.weightChange - right.weightChange) * (rank === "decreases" ? 1 : -1);
        });
        return { columns: [{ key: "ticker", header: "Ticker" }, { key: "issuer", header: "Issuer" }, { key: "type", header: "Type" }, { key: "holderCount", header: "Funds", align: "right" }, { key: "newCount", header: "New", align: "right" }, { key: "exitCount", header: "Exits", align: "right" }, { key: "weightChange", header: "Weight change", align: "right", format: weightPoints }, { key: "comparedFunds", header: "Compared", align: "right" }, { key: "totalValue", header: "Value", align: "right", format: money }], rows: rows.slice(0, limit).map(row => ({ ...row })),
          // The pane states the fund sample beside the table; the text report needs it too.
          metadata: { ...metadata, view, rank, truncated: rows.length > limit, notices: [`${metadata.period}: ${metadata.loadedFunds}/${metadata.sourceFunds} ranked funds`] }, errors: metadata.warnings };
      }
      if (view === "ticker-holdings") {
        if (!query) throw new Error("13F ticker holdings requires a ticker.");
        const { rows, ...metadata } = await loadTickerHoldings(query.toUpperCase(), Number(args.options.offset ?? 0), ctx.signal);
        return { columns: [{ key: "fund", header: "Fund" }, { key: "cik", header: "CIK" }, { key: "type", header: "Type" }, { key: "value", header: "Value", align: "right", format: money }, { key: "shares", header: "Shares", align: "right", format: shares }, { key: "weight", header: "13F weight", align: "right", format: weight }, { key: "action", header: "Action" }], rows: rows.slice(0, limit).map(row => ({ ...row })), metadata: { ...metadata, view, truncated: rows.length > limit }, errors: metadata.warnings };
      }

      if (view === "holdings" || view === "filings") {
        const fund = await resolveFund(query, args, ctx, dependencies);
        const detail = await dependencies.loadDetail(fund.cik, fund.name, args, ctx);
        if (view === "filings") {
          const rows = sortTimelineRows(buildTimelineRows(detail.forms), DEFAULT_TIMELINE_SORT)
            .slice(0, limit)
            .map((row) => ({ ...row }));
          return {
            columns: FILING_COLUMNS,
            rows,
            ...(detail.warnings?.length ? { errors: detail.warnings } : {}),
            metadata: {
              view,
              cik: detail.cik,
              fund: detail.name,
              latestPeriod: detail.latestForm?.periodOfReport ?? null,
            },
          };
        }
        const rows = sortHoldingRows(
          buildFundHoldingRows(detail),
          DEFAULT_HOLDING_SORT,
        )
          .slice(0, limit)
          .map((row) => ({
            ...row,
            type: positionType(row),
            actionLabel: actionLabel(row.action),
          }));
        return {
          columns: HOLDING_COLUMNS,
          rows,
          ...(detail.warnings?.length ? { errors: detail.warnings } : {}),
          metadata: {
            view,
            cik: detail.cik,
            fund: detail.name,
            latestPeriod: detail.latestForm?.periodOfReport ?? null,
            previousPeriod: detail.previousForm?.periodOfReport ?? null,
            comparisonAvailable: hasComparable13FQuarter(detail),
            currentFilings: detail.latestReport?.filings.map((form) => form.accessionNumber) ?? [],
            previousFilings: detail.previousReport?.filings.map((form) => form.accessionNumber) ?? [],
            currentReportedValue: detail.latestReport?.complete ? detail.latestReport.tableValueTotal : null,
            changeBasis: "Changes compare disclosed quarter-end positions, not trades. Omitted or confidential holdings can affect apparent entries and exits.",
            valueBasis: THIRTEENF_OPTIONS_NOTE,
            estimatedPnlBasis: "Quarter-end unit-value change on overlapping reported shares; excludes options, trading costs and dividends; not actual fund P&L.",
          },
        };
      }

      const tab = browserTab(view, query);
      const result = await dependencies.loadBrowser(tab, query, limit, args, ctx);
      return {
        columns: result.rows[0]?.priorReturns?.length ? [...BROWSER_COLUMNS.filter(column => !["filedAsOfDate", "tableEntryTotal"].includes(column.key)), ...result.rows[0].priorReturns.map((point, index) => ({ key: `return${index + 1}`, header: point.quarter, align: "right" as const, format: (value: unknown) => formatRawPercentMaybe(typeof value === "number" ? value : null) }))] : BROWSER_COLUMNS,
        rows: sortBrowserRows(result.rows, DEFAULT_BROWSER_SORT)
          .slice(0, limit)
          .map((row) => ({ ...row, ...Object.fromEntries((row.priorReturns ?? []).map((point, index) => [`return${index + 1}`, point.value])) })),
        ...(result.warning ? { errors: [result.warning] } : {}),
        metadata: {
          view: tab,
          query: query || null,
          period: result.period ?? null,
          quarter: result.quarter ?? null,
          hasMore: result.hasMore ?? false,
        },
      };
    },
  };
}

export const thirteenFHeadless = createThirteenFHeadless();
