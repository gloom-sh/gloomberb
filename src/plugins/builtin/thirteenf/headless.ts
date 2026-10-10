import type {
  HeadlessPaneColumn,
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import { formatShortDate } from "../../../utils/datetime-format";
import { normalizeCik } from "./api";
import { buildFundOverlap, overlapPeriod } from "./overlap";
import { appendTickerHoldings, loadCrowding, loadTickerHoldings, type CrowdingRow, type TickerHoldings } from "./signals";
import {
  AS_FILED_VALUE,
  compareCrowding,
  crowdingForTicker,
  cutText,
  periodText,
  summarizeTickerHoldings,
  THIRTEENF_MAX_LIMIT,
} from "./report-notes";
import {
  loadBrowserRows,
  loadFundDetail,
  type BrowserLoadResult,
} from "./data";
import {
  DEFAULT_BROWSER_SORT,
  browserSortFor,
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
  FILING_DAY_FORMAT,
  formatWeightMaybe,
} from "./format";
import type {
  FundDetailData,
  ThirteenFBrowserTab,
} from "./types";
import { finiteOrNull } from "../../../utils/guards";
import { SEC_FILINGS } from "../shared/report-freshness";

const money = (value: unknown) => formatMoneyCompact(finiteOrNull(value));
const weight = (value: unknown) => formatWeightMaybe(finiteOrNull(value));
const shares = (value: unknown) => formatShares(finiteOrNull(value));
const weightPoints = (value: unknown) => {
  const change = finiteOrNull(value);
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
    header: "Value (USD)",
    align: "right",
    format: (value) => formatMoneyCompact(value == null ? null : Number(value)),
  },
  { key: "tableEntryTotal", header: "Rows", align: "right" },
  {
    key: "filedAsOfDate",
    header: "Filed",
    format: (value) => formatShortDate(typeof value === "string" ? value : null, FILING_DAY_FORMAT),
  },
];

const HOLDING_COLUMNS: HeadlessPaneColumn[] = [
  { key: "ticker", header: "Ticker" },
  { key: "type", header: "Type" },
  { key: "issuer", header: "Issuer" },
  {
    key: "value",
    header: "Value (USD)",
    align: "right",
    format: (value) => formatMoneyCompact(value == null ? null : Number(value)),
  },
  {
    key: "estimatedPnl",
    header: "Est P&L (USD)",
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
    format: (value) => formatShortDate(typeof value === "string" ? value : null, FILING_DAY_FORMAT),
  },
  {
    key: "tableValueTotal",
    header: "Value (USD)",
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

const VIEW_TITLES: Record<string, string> = {
  overlap: "13F Overlap",
  crowding: "13F Crowding",
  "ticker-holdings": "13F Holders",
  byTicker: "13F Holders",
  "by-ticker": "13F Holders",
  holdings: "13F Holdings",
  filings: "13F Filings",
  performance: "13F Performance",
  funds: "13F Funds",
  latest: "13F Latest Filings",
};

/** The view a query resolved to and what it is about, never the bare `auto` it was asked as. */
function thirteenFTitle(args: HeadlessPaneLoadArgs, metadata: Record<string, unknown> | undefined): string {
  const query = typeof args.argument === "string" ? args.argument.trim() : "";
  const view = String(metadata?.view ?? args.options.view);
  const text = (value: unknown) => (typeof value === "string" && value ? value : "");
  const subject = view === "overlap" && metadata?.firstFund && metadata.secondFund
    ? `${text(metadata.firstFund)} vs ${text(metadata.secondFund)}`
    : text(metadata?.ticker) || text(metadata?.fund) || (view === "latest" || view === "performance" ? "" : query);
  return [VIEW_TITLES[view] ?? "13F Funds", subject].filter(Boolean).join(" | ");
}

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
    freshness: { ...SEC_FILINGS, basis: "13F filings", observedKey: "filedAsOfDate" },
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
        maximum: THIRTEENF_MAX_LIMIT,
      },
    ],
    describe: (args, result) => thirteenFTitle(args, result?.metadata),
    async load(args, ctx) {
      const query = typeof args.argument === "string" ? args.argument.trim() : "";
      const requestedView = String(args.options.view) as HeadlessThirteenFView;
      // A ticker's holders with their positions, not the holders' whole books.
      const view = requestedView !== "auto" ? requestedView
        : isCikQuery(query) ? "holdings"
          : inferBrowserTabFromQuery(query) === "byTicker" ? "ticker-holdings"
            : requestedView;
      const limit = Number(args.options.limit);
      if (view === "overlap") {
        const fund = await resolveFund(query, args, ctx, dependencies);
        const other = await resolveFund(String(args.options.compare ?? ""), args, ctx, dependencies);
        const [first, second] = await Promise.all([dependencies.loadDetail(fund.cik, fund.name, args, ctx), dependencies.loadDetail(other.cik, other.name, args, ctx)]);
        const comparedPeriod = overlapPeriod(first, second);
        const rows = buildFundOverlap(first, second);
        const cut = cutText(rows.length, limit, "positions");
        return { columns: [{ key: "ticker", header: "Ticker" }, { key: "type", header: "Type" }, { key: "issuer", header: "Issuer" }, { key: "weight", header: "First weight", align: "right", format: weight }, { key: "comparedWeight", header: "Second weight", align: "right", format: weight }], rows: rows.slice(0, limit).map(row => ({ ...row })), errors: [...(first.warnings ?? []), ...(second.warnings ?? []), ...(!comparedPeriod ? ["No reporting quarter is loaded for both funds."] : [])], metadata: { view, firstFund: first.name, secondFund: second.name, firstPeriod: first.latestForm?.periodOfReport ?? null, secondPeriod: second.latestForm?.periodOfReport ?? null, comparedPeriod, shown: Math.min(rows.length, limit), total: rows.length, truncated: rows.length > limit, notices: [[comparedPeriod ? `Quarter compared: ${comparedPeriod}` : "", cut].filter(Boolean).join(" | ")].filter(Boolean) } };
      }
      if (view === "crowding") {
        const { rows: sourceRows, ...metadata } = await loadCrowding(ctx.signal);
        const rank = String(args.options.rank ?? "new");
        const ranked = [...sourceRows].sort((left, right) => compareCrowding(rank, left, right));
        // The pane states the fund sample beside the table; the text report needs it too.
        const sample = `${metadata.period}: ${metadata.loadedFunds}/${metadata.sourceFunds} ranked funds`;
        const ticker = query ? query.replace(/^\$/, "").toUpperCase() : null;
        const focus = ticker ? crowdingForTicker(ranked, ticker, rank) : null;
        const rows: Array<CrowdingRow & { rank?: number }> = focus ? focus.rows : ranked;
        const columns: HeadlessPaneColumn[] = [{ key: "ticker", header: "Ticker" }, { key: "issuer", header: "Issuer" }, { key: "type", header: "Type" }, { key: "holderCount", header: "Funds", align: "right" }, { key: "newCount", header: "New", align: "right" }, { key: "exitCount", header: "Exits", align: "right" }, { key: "weightChange", header: "Weight change", align: "right", format: weightPoints }, { key: "comparedFunds", header: "Compared", align: "right" }, { key: "totalValue", header: "Value (USD)", align: "right", format: money }];
        const cut = cutText(rows.length, limit, "securities");
        return { columns: focus ? [{ key: "rank", header: "Rank", align: "right" }, ...columns] : columns, rows: rows.slice(0, limit).map(row => ({ ...row })),
          metadata: { ...metadata, view, rank, ...(ticker ? { ticker, found: rows.length > 0, rankedSecurities: ranked.length } : {}), shown: Math.min(rows.length, limit), total: rows.length, truncated: rows.length > limit, notices: [[sample, cut].filter(Boolean).join(" | "), ...(focus ? [focus.notice] : [])] },
          freshness: { asOf: metadata.period }, errors: metadata.warnings };
      }
      let holdings: TickerHoldings | null = null;
      if (view === "ticker-holdings") {
        if (!query) throw new Error("13F ticker holdings requires a ticker.");
        const ticker = query.replace(/^\$/, "").toUpperCase();
        try {
          holdings = await loadTickerHoldings(ticker, Number(args.options.offset ?? 0), ctx.signal);
          // The endpoint pages 25 funds at a time.
          while (holdings.hasMore && holdings.rows.length < limit) {
            holdings = appendTickerHoldings(holdings, await loadTickerHoldings(ticker, holdings.nextOffset, ctx.signal));
          }
        } catch (error) {
          // A ticker without a mapped CUSIP falls back to the holders listing.
          if (requestedView !== "auto" || ctx.signal?.aborted) throw error;
        }
      }
      if (holdings) {
        const { rows, ...metadata } = holdings;
        const offset = Number(args.options.offset ?? 0);
        const summary = summarizeTickerHoldings({ ...metadata, offset, limit, loaded: rows });
        return {
          columns: [{ key: "fund", header: "Fund" }, { key: "cik", header: "CIK" }, { key: "type", header: "Type" }, { key: "value", header: "Value (USD)", align: "right", format: money }, { key: "shares", header: "Shares", align: "right", format: shares }, { key: "weight", header: "13F weight", align: "right", format: weight }, { key: "action", header: "Action" }],
          rows: rows.slice(0, limit).map(row => ({ ...row })),
          metadata: {
            ...metadata,
            view,
            offset,
            shown: Math.min(rows.length, limit),
            shownFunds: summary.shownFunds,
            total: summary.total,
            truncated: summary.truncated,
            hasMore: summary.truncated,
            nextOffset: summary.nextOffset,
            // The value of the rows shown, not of every fund a page loaded.
            totalValue: summary.shownValue,
            valueScope: "shown funds",
            valueBasis: "as reported at period end",
            notices: summary.notices,
          },
          freshness: { asOf: metadata.period },
          errors: metadata.warnings,
        };
      }

      if (view === "holdings" || view === "filings") {
        const fund = await resolveFund(query, args, ctx, dependencies);
        const detail = await dependencies.loadDetail(fund.cik, fund.name, args, ctx);
        const latestPeriod = detail.latestForm?.periodOfReport ?? null;
        if (view === "filings") {
          const all = sortTimelineRows(buildTimelineRows(detail.forms), DEFAULT_TIMELINE_SORT);
          const rows = all
            .slice(0, limit)
            .map((row) => ({ ...row }));
          const cut = cutText(all.length, limit, "filings");
          return {
            columns: FILING_COLUMNS,
            rows,
            ...(detail.warnings?.length ? { errors: detail.warnings } : {}),
            metadata: {
              view,
              cik: detail.cik,
              fund: detail.name,
              latestPeriod,
              shown: rows.length,
              total: all.length,
              truncated: all.length > limit,
              notices: [[`CIK ${detail.cik}`, cut].filter(Boolean).join(" | ")],
            },
          };
        }
        const all = sortHoldingRows(
          buildFundHoldingRows(detail),
          DEFAULT_HOLDING_SORT,
        );
        const previousPeriod = detail.previousForm?.periodOfReport ?? null;
        const cut = cutText(all.length, limit, "positions, exits included");
        const rows = all
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
          // Positions as of the quarter they report; the rows carry no filing date.
          ...(latestPeriod ? { freshness: { asOf: latestPeriod } } : {}),
          metadata: {
            view,
            cik: detail.cik,
            fund: detail.name,
            latestPeriod,
            previousPeriod,
            shown: rows.length,
            total: all.length,
            truncated: all.length > limit,
            notices: [
              [`CIK ${detail.cik}`, periodText(latestPeriod, hasComparable13FQuarter(detail) ? previousPeriod : null), AS_FILED_VALUE].filter(Boolean).join(" | "),
              ...(cut ? [`${cut[0]!.toUpperCase()}${cut.slice(1)}`] : []),
            ],
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

      const tab = browserTab(view === "ticker-holdings" ? requestedView : view, query);
      const result = await dependencies.loadBrowser(tab, query, limit, args, ctx);
      const more = result.hasMore || result.rows.length > limit;
      return {
        columns: result.rows[0]?.priorReturns?.length ? [...BROWSER_COLUMNS.filter(column => !["filedAsOfDate", "tableEntryTotal"].includes(column.key)), ...result.rows[0].priorReturns.map((point, index) => ({ key: `return${index + 1}`, header: point.quarter, align: "right" as const, format: (value: unknown) => formatRawPercentMaybe(typeof value === "number" ? value : null) }))]
          : tab === "performance" ? BROWSER_COLUMNS : BROWSER_COLUMNS.filter(column => column.key !== "estQuarterReturn"),
        rows: sortBrowserRows(result.rows, browserSortFor(DEFAULT_BROWSER_SORT, tab))
          .slice(0, limit)
          .map((row) => ({ ...row, ...Object.fromEntries((row.priorReturns ?? []).map((point, index) => [`return${index + 1}`, point.value])) })),
        ...(result.warning ? { errors: [result.warning] } : {}),
        metadata: {
          view: tab,
          query: query || null,
          period: result.period ?? null,
          quarter: result.quarter ?? null,
          hasMore: result.hasMore ?? false,
          shown: Math.min(result.rows.length, limit),
          truncated: more,
          notices: more
            ? [[`Showing the first ${Math.min(result.rows.length, limit)}`, limit < THIRTEENF_MAX_LIMIT ? `more: --limit ${THIRTEENF_MAX_LIMIT}` : ""].filter(Boolean).join(" | ")]
            : [],
        },
      };
    },
  };
}

export const thirteenFHeadless = createThirteenFHeadless();
