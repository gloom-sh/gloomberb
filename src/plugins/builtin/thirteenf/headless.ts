import type {
  HeadlessPaneColumn,
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import { normalizeCik } from "./api";
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
} from "./format";
import type {
  FundDetailData,
  ThirteenFBrowserTab,
} from "./types";

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
    format: (value) => formatPercentMaybe(value == null ? null : Number(value)),
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
];

type HeadlessThirteenFView =
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
      {
        key: "view",
        description: "Fund browser mode or detail tab.",
        type: "enum",
        values: [
          { value: "auto" },
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
            metadata: {
              view,
              cik: detail.cik,
              fund: detail.name,
              latestPeriod: detail.latestForm?.periodOfReport ?? null,
            },
          };
        }
        const rows = sortHoldingRows(
          buildFundHoldingRows(detail).filter((row) => row.value != null),
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
          metadata: {
            view,
            cik: detail.cik,
            fund: detail.name,
            latestPeriod: detail.latestForm?.periodOfReport ?? null,
            previousPeriod: detail.previousForm?.periodOfReport ?? null,
            comparisonAvailable: hasComparable13FQuarter(detail),
            valueBasis: THIRTEENF_OPTIONS_NOTE,
            estimatedPnlBasis: "Quarter-end unit-value change on overlapping reported shares; excludes options, trading costs and dividends; not actual fund P&L.",
          },
        };
      }

      const tab = browserTab(view, query);
      const result = await dependencies.loadBrowser(tab, query, limit, args, ctx);
      return {
        columns: BROWSER_COLUMNS,
        rows: sortBrowserRows(result.rows, DEFAULT_BROWSER_SORT)
          .slice(0, limit)
          .map((row) => ({ ...row })),
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
