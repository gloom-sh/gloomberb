import type {
  HeadlessPaneColumn,
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import { formatShortDate } from "../../../utils/datetime-format";
import { normalizeCik } from "./api";
import { buildFundOverlap, buildManagerEtfOverlap, overlapPeriod } from "./overlap";
import type { FundMembersPayload, MemberFundsPayload } from "../../../api-client/members";
import { fetchFunds, fetchMembers } from "../members/client";
import { coveredFund } from "../members/model";
import { appendTickerHoldings, loadCrowding, loadTickerHoldings, type CrowdingRow, type TickerHoldings } from "./signals";
import {
  AS_FILED_VALUE,
  compareCrowding,
  crowdingForTicker,
  cutText,
  filedPeriodText,
  filingDayText,
  filingLagDays,
  isOptionType,
  isStaleFiling,
  markedPositionType,
  OPTION_ROWS_NOTE,
  staleFilingText,
  staleFundsText,
  summarizeTickerHoldings,
  THIRTEENF_LIMITS,
  THIRTEENF_MAX_LIMIT,
  THIRTEENF_OPTIONS_NOTE,
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
  isCikQuery,
  positionType,
  quartersBehindLatest,
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

/** What a 13F position report notes after its table: the filing's limits, and what the option marker means when option rows are shown. */
function positionNotes(rows: readonly { type?: unknown }[]): string[] {
  return [THIRTEENF_LIMITS, ...(rows.some((row) => isOptionType(row.type)) ? [OPTION_ROWS_NOTE] : [])];
}

const TYPE_COLUMN: HeadlessPaneColumn = { key: "type", header: "Type", textFormat: markedPositionType };

const HOLDING_COLUMNS: HeadlessPaneColumn[] = [
  { key: "ticker", header: "Ticker" },
  TYPE_COLUMN,
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
  /** The ETFs whose holdings files MEMB serves. */
  loadEtfFunds?(ctx: HeadlessPaneContext): Promise<MemberFundsPayload["funds"]>;
  /** One covered ETF's holdings file, as `fn MEMB` reads it. */
  loadEtfHoldings?(ticker: string, ctx: HeadlessPaneContext): Promise<FundMembersPayload>;
}

const defaultDependencies: Required<ThirteenFHeadlessDependencies> = {
  loadBrowser: (tab, query, limit, _args, ctx) => loadBrowserRows(
    tab,
    query,
    ctx.signal,
    { limit },
  ),
  loadDetail: (cik, name, _args, ctx) => loadFundDetail(cik, name, ctx.signal),
  loadEtfFunds: async (ctx) => (await fetchFunds(ctx.apiClient)).funds,
  loadEtfHoldings: (ticker, ctx) => fetchMembers(ticker, ctx.apiClient),
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

/**
 * The manager a fund name or CIK names: a CIK as given, else the one fund
 * whose name matches exactly, else the only match. `search` lists funds by
 * name, as the 13F browser does.
 */
async function findThirteenFFund(
  query: string,
  search: (query: string, limit: number) => Promise<BrowserLoadResult>,
  { exactOnly = false }: { exactOnly?: boolean } = {},
): Promise<{ cik: string; name: string } | null> {
  if (isCikQuery(query)) return { cik: normalizeCik(query), name: query };
  // A small output limit must not hide other matching managers during lookup.
  const result = await search(query, 25);
  const candidates = [...new Map(result.rows.map((row) => [row.cik, row])).values()];
  const exact = candidates.filter((row) => row.name.toLocaleLowerCase() === query.toLocaleLowerCase());
  if (exactOnly) return exact.length === 1 ? { cik: exact[0]!.cik, name: exact[0]!.name } : null;
  const fund = exact.length === 1 ? exact[0]
    : candidates.length === 1 && !result.hasMore ? candidates[0] : undefined;
  if (candidates.length === 0) throw new Error(`No 13F fund found for "${query}".`);
  if (!fund) {
    const choices = candidates.slice(0, 5).map((row) => `${row.name} (${row.cik})`).join("; ");
    throw new Error(`Ambiguous 13F fund "${query}". Use an exact fund name or CIK: ${choices}.`);
  }
  return { cik: fund.cik, name: fund.name };
}

async function resolveFund(
  query: string,
  args: HeadlessPaneLoadArgs,
  ctx: HeadlessPaneContext,
  dependencies: ThirteenFHeadlessDependencies,
): Promise<{ cik: string; name: string }> {
  if (!query) throw new Error("13F holdings and filings require a fund name or CIK.");
  return (await findThirteenFFund(query, (text, limit) => dependencies.loadBrowser("funds", text, limit, args, ctx)))!;
}

/** A word that reads as a ticker (SPY, BRK.B), not a manager's name or a CIK. */
const TICKER_WORD = /^\$?[A-Za-z]{1,5}(?:[.-][A-Za-z])?$/;

type OverlapComparison =
  | { kind: "fund"; cik: string; name: string }
  | { kind: "etf"; symbol: string; ticker: string; name: string };

/** "IVV (also SPY, SPX), IJH": the covered funds and the aliases each answers to. */
const coveredEtfs = (funds: MemberFundsPayload["funds"]) => funds
  .map((fund) => fund.aliases.length ? `${fund.ticker} (also ${fund.aliases.join(", ")})` : fund.ticker).join(", ");

/**
 * What `--compare` names. A ticker-like word is an ETF when MEMB has its
 * holdings file, else a 13F manager only by its exact name; it is never
 * matched to a manager by a partial name (SPY is not Spyglass Capital).
 * Anything else, a CIK or a longer name, is a 13F manager as before.
 */
async function resolveComparison(
  text: string,
  args: HeadlessPaneLoadArgs,
  ctx: HeadlessPaneContext,
  dependencies: Required<ThirteenFHeadlessDependencies>,
): Promise<OverlapComparison> {
  if (isCikQuery(text) || !TICKER_WORD.test(text)) return { kind: "fund", ...await resolveFund(text, args, ctx, dependencies) };
  const symbol = text.replace(/^\$/, "").toUpperCase();
  let funds: MemberFundsPayload["funds"] | null = null;
  let failure = "";
  try {
    funds = await dependencies.loadEtfFunds(ctx);
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    failure = error instanceof Error ? error.message : String(error);
  }
  const etf = funds ? coveredFund(funds, symbol) : undefined;
  if (etf) return { kind: "etf", symbol, ticker: etf.ticker, name: etf.name };
  const manager = await findThirteenFFund(text, (query, limit) => dependencies.loadBrowser("funds", query, limit, args, ctx), { exactOnly: true });
  if (manager) return { kind: "fund", ...manager };
  const etfs = funds ? `${symbol} is not an ETF MEMB covers (covered: ${coveredEtfs(funds)})` : `${symbol} could not be checked against MEMB's ETFs (${failure})`;
  throw new Error(`${etfs}, and no 13F manager is named "${text}". For a manager, use its CIK or full name.`);
}

const percentText = (value: number) => `${(value * 100).toFixed(1)}%`;

export function createThirteenFHeadless(
  overrides: ThirteenFHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  const dependencies: Required<ThirteenFHeadlessDependencies> = { ...defaultDependencies, ...overrides };
  return {
    shape: "rows",
    freshness: { ...SEC_FILINGS, basis: "13F filings", observedKey: "filedAsOfDate" },
    discovery: { limitations: [THIRTEENF_LIMITS] },
    argument: {
      kind: "free-text",
      placeholder: "fund, ticker, or CIK",
      description: "Optional fund name, ticker, CIK, or latest keyword.",
      optional: true,
    },
    options: [
      // No defaults on view-specific options, so a flag the view does not use can be named as ignored.
      { key: "rank", description: "Crowding order (crowding view; new when left out).", type: "enum", values: [{ value: "new" }, { value: "exits" }, { value: "increases" }, { value: "decreases" }] },
      { key: "compare", description: "Second fund name or CIK, or an ETF ticker MEMB covers such as SPY; implies the overlap view.", type: "string" },
      { key: "offset", description: "Fund offset for ticker-holdings (0 when left out).", type: "integer", minimum: 0, maximum: 100000 },
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
      const compare = typeof args.options.compare === "string" ? args.options.compare.trim() : "";
      if (compare && requestedView !== "auto" && requestedView !== "overlap") {
        throw new Error(`--compare is for the overlap view; --view ${requestedView} does not use it. Drop --view, or use --view overlap.`);
      }
      // A ticker's holders with their positions, not the holders' whole books.
      const view = compare ? "overlap"
        : requestedView !== "auto" ? requestedView
          : isCikQuery(query) ? "holdings"
            : inferBrowserTabFromQuery(query) === "byTicker" ? "ticker-holdings"
              : requestedView;
      // A flag the view does not use is named, never dropped without a word.
      const flagNotices = [
        compare && requestedView === "auto" ? "--compare implies --view overlap" : "",
        args.options.rank != null && view !== "crowding" ? "--rank orders --view crowding only; ignored here" : "",
        args.options.offset != null && view !== "ticker-holdings" ? "--offset pages a ticker's holders only; ignored here" : "",
        query && (view === "latest" || view === "performance") ? `--view ${view} lists every manager; "${query}" is not used` : "",
      ].filter(Boolean);
      const limit = Number(args.options.limit);
      if (view === "overlap") {
        if (!compare) throw new Error(`13F overlap compares two holdings: add --compare <fund name, CIK or ETF ticker>, as in fn 13F ${query || "<fund or CIK>"} --compare SPY.`);
        if (!query) throw new Error("13F overlap needs a fund name or CIK first: fn 13F <fund or CIK> --compare <fund, CIK or ETF ticker>.");
        const fund = await resolveFund(query, args, ctx, dependencies);
        const other = await resolveComparison(compare, args, ctx, dependencies);
        if (other.kind === "etf") {
          const [first, etf] = await Promise.all([dependencies.loadDetail(fund.cik, fund.name, args, ctx), dependencies.loadEtfHoldings(other.ticker, ctx)]);
          const overlap = buildManagerEtfOverlap(first, etf.members);
          const period = first.latestForm?.periodOfReport ?? null;
          const filed = first.latestForm?.filedAsOfDate ?? null;
          const rows = overlap?.rows ?? [];
          const cut = cutText(rows.length, limit, "positions");
          const missing = overlap?.missing ?? [];
          const missingNames = missing.slice(0, 5).map((row) => `${row.ticker || row.issuer} ${weight(row.weight)}`).join(", ");
          const leftOut = overlap ? [overlap.leftOut.options ? `${overlap.leftOut.options} option line${overlap.leftOut.options === 1 ? "" : "s"}` : "", overlap.leftOut.principal ? `${overlap.leftOut.principal} principal-amount line${overlap.leftOut.principal === 1 ? "" : "s"}` : ""].filter(Boolean) : [];
          const etfWeight = (value: unknown, row: Record<string, unknown>) => row.etfWeight == null ? "no ticker" : value === 0 ? "not held" : weight(value);
          return {
            columns: [{ key: "ticker", header: "Ticker" }, { key: "issuer", header: "Issuer" }, { key: "weight", header: "13F weight", align: "right", format: weight }, { key: "etfWeight", header: `${other.symbol} weight`, align: "right", format: etfWeight }, { key: "shared", header: "Shared", align: "right", format: weight }],
            rows: rows.slice(0, limit).map((row) => ({ ...row })),
            errors: [
              ...(first.warnings ?? []),
              ...(first.latestReport?.complete === false ? [`The 13F for ${period} did not load completely; weights cover the lines that did.`] : []),
              ...(etf.stale ? [`The ${other.ticker} holdings file is stale.`] : []),
              ...(!overlap ? ["No share positions or ETF weights to compare."] : []),
            ],
            freshness: { source: "SEC EDGAR and Gloom Cloud", ...(period ? { asOf: period } : {}) },
            metadata: {
              view, comparedWith: "etf", firstFund: first.name, cik: first.cik, secondFund: other.symbol,
              etf: { symbol: other.symbol, ticker: other.ticker, name: other.name, asOf: etf.asOf },
              comparedPeriod: period, filed,
              overlap: overlap?.overlap ?? null, activeShare: overlap?.activeShare ?? null,
              missing: missing.map((row) => ({ ticker: row.ticker || null, issuer: row.issuer, weight: row.weight, reason: row.etfWeight == null ? "no ticker" : "not held" })),
              missingWeight: overlap?.missingWeight ?? null,
              leftOut: overlap?.leftOut ?? null,
              shown: Math.min(rows.length, limit), total: rows.length, truncated: rows.length > limit,
              notices: [
                ...flagNotices,
                `${other.symbol} read as an ETF: ${other.name} holdings${other.ticker !== other.symbol ? ` (${other.ticker} file)` : ""}, as fn MEMB ${other.symbol} shows`,
                ...(overlap ? [`Overlap ${percentText(overlap.overlap)} (sum of the smaller weight per name) | Active share ${percentText(overlap.activeShare)}`] : []),
                [
                  period ? `Quarter compared: ${filingDayText(period)}${filed ? `, filed ${filingDayText(filed)}` : ""}` : "",
                  `${other.symbol} holdings as of ${filingDayText(etf.asOf.slice(0, 10))}`,
                  leftOut.length ? `13F weights leave out ${leftOut.join(" and ")}` : "",
                ].filter(Boolean).join(" | "),
                ...(overlap ? [missing.length ? `Not in ${other.symbol}: ${missing.length} of ${rows.length} positions, ${percentText(overlap.missingWeight)} of the 13F | ${missingNames}${missing.length > 5 ? ", ..." : ""}` : `${other.symbol} holds every position in the 13F`] : []),
                ...(cut ? [`${cut[0]!.toUpperCase()}${cut.slice(1)}`] : []),
              ].filter(Boolean),
            },
          };
        }
        const [first, second] = await Promise.all([dependencies.loadDetail(fund.cik, fund.name, args, ctx), dependencies.loadDetail(other.cik, other.name, args, ctx)]);
        const comparedPeriod = overlapPeriod(first, second);
        const rows = buildFundOverlap(first, second);
        const cut = cutText(rows.length, limit, "positions");
        const read = `${compare} read as the 13F manager ${second.name} (CIK ${second.cik})`;
        return { columns: [{ key: "ticker", header: "Ticker" }, { key: "type", header: "Type" }, { key: "issuer", header: "Issuer" }, { key: "weight", header: "First weight", align: "right", format: weight }, { key: "comparedWeight", header: "Second weight", align: "right", format: weight }], rows: rows.slice(0, limit).map(row => ({ ...row })), errors: [...(first.warnings ?? []), ...(second.warnings ?? []), ...(!comparedPeriod ? ["No reporting quarter is loaded for both funds."] : [])], metadata: { view, comparedWith: "fund", firstFund: first.name, secondFund: second.name, firstPeriod: first.latestForm?.periodOfReport ?? null, secondPeriod: second.latestForm?.periodOfReport ?? null, comparedPeriod, shown: Math.min(rows.length, limit), total: rows.length, truncated: rows.length > limit, notices: [...flagNotices, read, [comparedPeriod ? `Quarter compared: ${comparedPeriod}` : "", cut].filter(Boolean).join(" | ")].filter(Boolean) } };
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
          metadata: { ...metadata, view, rank, ...(ticker ? { ticker, found: rows.length > 0, rankedSecurities: ranked.length } : {}), shown: Math.min(rows.length, limit), total: rows.length, truncated: rows.length > limit, notices: [...flagNotices, [sample, cut].filter(Boolean).join(" | "), ...(focus ? [focus.notice] : [])] },
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
        const shown = rows.slice(0, limit).map(row => ({ ...row }));
        return {
          columns: [{ key: "fund", header: "Fund" }, { key: "cik", header: "CIK" }, TYPE_COLUMN, { key: "value", header: "Value (USD)", align: "right", format: money }, { key: "shares", header: "Shares", align: "right", format: shares }, { key: "weight", header: "13F weight", align: "right", format: weight }, { key: "action", header: "Action" }],
          rows: shown,
          notes: positionNotes(shown),
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
            notices: [...flagNotices, ...summary.notices],
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
              notices: [...flagNotices, [`CIK ${detail.cik}`, cut].filter(Boolean).join(" | ")],
            },
          };
        }
        const all = sortHoldingRows(
          buildFundHoldingRows(detail),
          DEFAULT_HOLDING_SORT,
        );
        const previousPeriod = detail.previousForm?.periodOfReport ?? null;
        const comparable = hasComparable13FQuarter(detail);
        const filed = detail.latestForm?.filedAsOfDate || null;
        const quartersBehind = quartersBehindLatest(latestPeriod);
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
          notes: positionNotes(rows),
          // Dated by the filing that made the positions public, with the quarter they report beside it.
          ...(latestPeriod ? { freshness: {
            asOf: filed ?? latestPeriod,
            basis: `13F filing for the quarter ended ${filingDayText(latestPeriod)}`,
          } } : {}),
          metadata: {
            view,
            cik: detail.cik,
            fund: detail.name,
            latestPeriod,
            latestFiled: filed,
            filingLagDays: filingLagDays(latestPeriod, filed),
            quartersBehind,
            previousPeriod,
            shown: rows.length,
            total: all.length,
            truncated: all.length > limit,
            notices: [
              ...flagNotices,
              [`CIK ${detail.cik}`, filedPeriodText(latestPeriod, filed, comparable ? previousPeriod : null)].filter(Boolean).join(" | "),
              AS_FILED_VALUE,
              ...(isStaleFiling(quartersBehind) ? [staleFilingText(quartersBehind)] : []),
              ...(cut ? [`${cut[0]!.toUpperCase()}${cut.slice(1)}`] : []),
            ],
            comparisonAvailable: comparable,
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
      const browserRows = sortBrowserRows(result.rows, browserSortFor(DEFAULT_BROWSER_SORT, tab)).slice(0, limit);
      // A search finds managers that stopped filing; say which, since the Period column alone reads like any other.
      const stale = tab === "funds"
        ? browserRows.flatMap((row) => {
          const quarters = quartersBehindLatest(row.periodOfReport);
          return isStaleFiling(quarters) ? [{ name: row.name, quarters }] : [];
        })
        : [];
      return {
        columns: result.rows[0]?.priorReturns?.length ? [...BROWSER_COLUMNS.filter(column => !["filedAsOfDate", "tableEntryTotal"].includes(column.key)), ...result.rows[0].priorReturns.map((point, index) => ({ key: `return${index + 1}`, header: point.quarter, align: "right" as const, format: (value: unknown) => formatRawPercentMaybe(typeof value === "number" ? value : null) }))]
          : tab === "performance" ? BROWSER_COLUMNS : BROWSER_COLUMNS.filter(column => column.key !== "estQuarterReturn"),
        rows: browserRows
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
          notices: [
            ...flagNotices,
            ...(more ? [[`Showing the first ${Math.min(result.rows.length, limit)}`, limit < THIRTEENF_MAX_LIMIT ? `more: --limit ${THIRTEENF_MAX_LIMIT}` : ""].filter(Boolean).join(" | ")] : []),
            ...(stale.length ? [staleFundsText(stale)] : []),
          ],
        },
      };
    },
  };
}

export const thirteenFHeadless = createThirteenFHeadless();
