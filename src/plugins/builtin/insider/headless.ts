import type {
  HeadlessPaneColumn,
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
  HeadlessPaneRow,
  HeadlessRowsResult,
} from "../../../types/plugin";
import { MISSING_VALUE, formatCompact, formatCurrency } from "../../../utils/format";
import { INSIDER_REPORT_FILINGS, loadParsedInsiderFilings, type InsiderFilingsLoad } from "./client";
import { insiderEmptyNotice, loadHomeInsiderReportsNote } from "./issuer";
import { FORM4_CURRENCY, withDayBaseValues, withInsiderBaseValues } from "./base-values";
import {
  buildInsiderRows,
  buildInsiderSummary,
  buildInsiderDisclosureText,
  isInsiderTypeFilter,
  matchesInsiderOwner,
  matchesInsiderTypeFilter,
  type ParsedInsiderFiling,
} from "./model";
import { isAmendedInsiderFiling, relevantInsiderAmendments } from "./amendments";
import { formatInsiderName, isOpenMarketTrade } from "./display";
import { SEC_FILING_ROWS } from "../shared/report-freshness";
import { resolveHeadlessInstrument, resolveHeadlessIssuerListing } from "../shared/headless-market-data";
import { noSecReportsNotice } from "../../../utils/sec";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import type { InsiderSignalRoleGroup, InsiderSignalSide, InsiderSignalsPayload } from "../../../api-client/insider-signals";
import {
  DEFAULT_INSIDER_SIGNALS_QUERY,
  loadInsiderCompany,
  loadInsiderSignals,
  type InsiderCompanyActivity,
  type InsiderCompanyQuery,
  type InsiderSignalsQuery,
} from "./signals-client";
import { compareSortValues } from "../../../utils/sort-values";
import {
  formatInsiderNth,
  formatInsiderStake,
  formatInsiderUsual,
  formatSignalDay,
  formatSignalValue,
  INSIDER_SIGNAL_CAP_OPTIONS,
  INSIDER_SIGNALS_TITLE,
  insiderActivityDefaultSort,
  insiderActivityEmptyTitle,
  insiderActivityLines,
  insiderActivitySortValue,
  insiderNth,
  insiderSideWords,
  insiderSignalLead,
  insiderSignalRoleText,
  insiderSignalsCoverageNotice,
  insiderSignalsEmptyTitle,
  insiderSignalsFiltered,
  insiderSignalWhy,
  insiderStakeFact,
  insiderStakeValue,
  insiderUsualRatio,
} from "./signals-model";
import { REPORT_ROWS } from "../shared/headless-options";
import { mapWithConcurrency } from "../../../utils/concurrency";
import { describeCollections, findNamedCollection, readWatchlistArgument, watchlistMemberSymbol } from "../../../portfolio/collection-name";
import type { FxHistoryClient } from "../../../market-data/fx-closes";

const INSIDER_COLUMNS: HeadlessPaneColumn[] = [
  { key: "form", header: "Form" },
  {
    key: "filingDate",
    header: "Filed",
    format: (value) => typeof value === "string" ? value.slice(0, 10) : MISSING_VALUE,
  },
  {
    key: "transactionDate",
    header: "Tx",
    format: (value) => typeof value === "string" ? value.slice(0, 10) : MISSING_VALUE,
  },
  {
    key: "insider",
    header: "Insider",
    format: (value) => typeof value === "string" ? formatInsiderName(value) : MISSING_VALUE,
  },
  { key: "title", header: "Title" },
  { key: "security", header: "Security" },
  {
    key: "side",
    header: "Side",
    // A filing without transaction lines, matching the pane's "Form 4 disclosure" row. An open-market
    // trade on a form with the Rule 10b5-1 box checked is marked as the pane marks it: BUY 10b5-1.
    format: (value, row) => typeof value === "string"
      ? `${value}${row.rule10b51 === true && isOpenMarketTrade(typeof row.transactionCode === "string" ? row.transactionCode : null) ? " 10b5-1" : ""}`
      : row.status === "disclosure" ? "DISCLOSURE" : MISSING_VALUE,
  },
  {
    key: "shares",
    header: "Shares",
    align: "right",
    format: (value) => value == null ? MISSING_VALUE : formatCompact(Number(value)),
  },
  {
    key: "pricePerShare",
    header: "Price",
    align: "right",
    format: (value) => value == null ? MISSING_VALUE : formatCurrency(Number(value)),
  },
  {
    key: "totalValue",
    header: "Value",
    align: "right",
    format: (value) => value == null ? MISSING_VALUE : `$${formatCompact(Number(value))}`,
  },
  // An amendment's original date, remarks and footnotes, under the amendment's own row.
  { key: "note", header: "Note", underRow: true, format: (value) => typeof value === "string" ? value : "" },
];

/** With a base currency other than USD, the dollar columns say they are in USD ("Bought (USD)"), as $ alone is several currencies' sign. */
function labelDollarColumns(columns: HeadlessPaneColumn[], keys: readonly string[], baseCurrency: string): HeadlessPaneColumn[] {
  if (baseCurrency.trim().toUpperCase() === FORM4_CURRENCY) return columns;
  return columns.map((column) => keys.includes(column.key) ? { ...column, header: `${column.header} (${FORM4_CURRENCY})` } : column);
}

/** A ranking's columns with each converted value right after its dollars, and the rate after the last. */
function withBaseColumns(columns: HeadlessPaneColumn[], based: readonly HeadlessPaneColumn[] | null): HeadlessPaneColumn[] {
  if (!based) return columns;
  const rate = based.filter((column) => column.key === "fxRate");
  const values = based.filter((column) => column.key !== "fxRate");
  const out = columns.flatMap((column) => [column, ...values.filter((value) => value.key === `${column.key}Base`)]);
  const last = Math.max(...values.map((value) => out.indexOf(value)));
  return [...out.slice(0, last + 1), ...rate, ...out.slice(last + 1)];
}

/** The trades' columns with the money ones labelled by currency and the converted value and rate after them (`withInsiderBaseValues`). */
function withMoneyColumns(money: readonly HeadlessPaneColumn[]): HeadlessPaneColumn[] {
  const byKey = new Map(money.map((column) => [column.key, column]));
  return INSIDER_COLUMNS.flatMap((column) => column.key === "totalValue"
    ? money.filter((entry) => entry.key !== "pricePerShare")
    : [byKey.get(column.key) ?? column]);
}

const figureOrDash = (value: unknown) => (typeof value === "number" ? value : null);
/** A ranking's dollars beside the side's own; none is a dash. */
const signalAmount = (value: unknown) => (typeof value === "number" && value > 0 ? formatSignalValue(value) : MISSING_VALUE);

/**
 * The ranking without a ticker: the pane's columns in the side's words, why
 * as the lead insider's role, nth trade, size against usual and stake. On a
 * narrow table the size against usual moves under the row first, then the
 * nth trade, the company and the filing day, as the pane drops them. The
 * exports also carry each row's insiders (`buyers`); the text leaves them to
 * `fn INS <ticker> --view insiders`, as the pane leaves them to the opened
 * company.
 */
function signalColumns(side: InsiderSignalSide): HeadlessPaneColumn[] {
  const words = insiderSideWords(side);
  return [
    { key: "ticker", header: "Ticker" },
    // The company is cut to 12 at the least, as the pane cuts it, and then moves under the row.
    { key: "company", header: "Company", minWidth: 12, stackPriority: 2 },
    { key: "score", header: "Score", align: "right" },
    { key: "role", header: "Role", shrink: false },
    { key: "nth", header: "Nth", align: "right", stackPriority: 3, format: (value) => formatInsiderNth(figureOrDash(value)) },
    { key: "vsUsual", header: "Vs Usual", align: "right", stackPriority: 4, format: (value) => formatInsiderUsual(figureOrDash(value)) },
    {
      key: "stake",
      header: "Stake",
      align: "right",
      shrink: false,
      format: (value, row) => formatInsiderStake(
        typeof value === "number" || value === "NEW" || value === "EXITED" ? value : null,
        row.stakeBothWays === true,
      ),
    },
    { key: "insiders", header: words.insiders, align: "right" },
    { key: "value", header: words.traded, align: "right", format: (value) => typeof value === "number" ? formatSignalValue(value) : MISSING_VALUE },
    // Buying is read beside what the score leaves out: purchases under a Rule 10b5-1 plan, and the sales of the same days.
    ...side === "buy" ? [
      { key: "planValue", header: "Plan Buys", align: "right" as const, format: signalAmount },
      { key: "soldValue", header: "Sold", align: "right" as const, format: signalAmount },
    ] : [],
    { key: "lastBuy", header: words.last, format: (value) => typeof value === "string" ? formatSignalDay(value) : MISSING_VALUE },
    { key: "filingDate", header: "Filed", stackPriority: 1, format: (value) => typeof value === "string" ? value : MISSING_VALUE },
    { key: "buyers", header: "Insiders", underRow: true, format: (value) => typeof value === "string" ? value : "" },
  ];
}

/** INS on a ticker, its insiders: one row each, in the ranking's columns, the dollars on the side their trades net to. */
const INSIDERS_COLUMNS: HeadlessPaneColumn[] = [
  { key: "insider", header: "Insider" },
  { key: "role", header: "Role", shrink: false },
  { key: "nth", header: "Nth", align: "right", stackPriority: 2, format: (value) => formatInsiderNth(figureOrDash(value)) },
  { key: "vsUsual", header: "Vs Usual", align: "right", stackPriority: 3, format: (value) => formatInsiderUsual(figureOrDash(value)) },
  {
    key: "stake",
    header: "Stake",
    align: "right",
    shrink: false,
    format: (value, row) => formatInsiderStake(
      typeof value === "number" || value === "NEW" || value === "EXITED" ? value : null,
      row.stakeBothWays === true,
    ),
  },
  { key: "bought", header: "Bought", align: "right", format: (value) => typeof value === "number" ? formatSignalValue(value) : MISSING_VALUE },
  // Of Bought, the dollars under a Rule 10b5-1 plan: a company asked for by its ticker counts them, the ranking does not.
  { key: "planBought", header: "Plan Buys", align: "right", format: (value) => typeof value === "number" ? formatSignalValue(value) : MISSING_VALUE },
  { key: "sold", header: "Sold", align: "right", format: (value) => typeof value === "number" ? formatSignalValue(value) : MISSING_VALUE },
  { key: "last", header: "Last", stackPriority: 1, format: (value) => typeof value === "string" ? formatSignalDay(value) : MISSING_VALUE },
];

/**
 * The insiders' table: Plan Buys only when an insider bought under a plan,
 * each dollar column headed with its currency, and with a base currency
 * other than USD each insider's dollars in it too, at the daily close of
 * their last trade day, as the ranking converts a company's.
 */
async function insidersTable(
  rows: readonly HeadlessPaneRow[],
  ctx: HeadlessPaneContext,
  dependencies: InsiderHeadlessDependencies,
): Promise<{ columns: HeadlessPaneColumn[]; rows: HeadlessPaneRow[]; notes: string[] }> {
  const columns = INSIDERS_COLUMNS.filter((column) => column.key !== "planBought" || rows.some((row) => typeof row.planBought === "number"));
  const based = await withDayBaseValues(rows, [{ key: "bought", header: "Bought" }, { key: "sold", header: "Sold" }], "last",
    ctx.config.baseCurrency, dependencies.fxHistory ?? ctx.apiClient);
  const base = ctx.config.baseCurrency.trim().toUpperCase();
  const pair = String(based.rows[0]?.fxPair ?? "");
  return {
    columns: withBaseColumns(labelDollarColumns(columns, ["bought", "planBought", "sold"], ctx.config.baseCurrency), based.columns),
    rows: based.rows,
    notes: [
      ...based.columns ? [`Bought (${base}) and Sold (${base}) are each insider's dollars at the ${pair} daily close of their last trade day, or of the trading day before it; ${pair} is that rate.`] : [],
      ...based.note ? [based.note] : [],
    ],
  };
}

/** The insiders as the pane lists them first: the side's dollars largest first, then the largest either way. */
function insidersRows(activity: InsiderCompanyActivity, side: InsiderSignalSide): HeadlessPaneRow[] {
  const sort = insiderActivityDefaultSort(side);
  return insiderActivityLines(activity)
    .map((line, index) => ({ line, index }))
    .sort((a, b) => compareSortValues(insiderActivitySortValue(a.line, sort.columnId), insiderActivitySortValue(b.line, sort.columnId), sort.direction) || a.index - b.index)
    .map(({ line }) => ({
      insider: line.name,
      reportedName: line.buyer.name,
      role: line.role,
      side: line.side,
      nth: insiderNth(line.buyer),
      vsUsual: insiderUsualRatio(line.buyer),
      stake: insiderStakeValue(line.buyer),
      stakeBothWays: line.buyer.twoWay === true,
      bought: line.bought,
      planBought: line.plan,
      sold: line.sold,
      currency: FORM4_CURRENCY,
      shares: line.buyer.shares ?? null,
      last: line.buyer.lastBuy,
    }));
}

/**
 * A row's fields: the columns' figures (the lead insider's nth trade, size
 * against usual and stake as numbers, NEW or EXITED), and `why` as the
 * server's sentences for the exports that read it.
 */
function signalRows(payload: InsiderSignalsPayload): HeadlessPaneRow[] {
  return payload.rows.map((row) => {
    const lead = insiderSignalLead(row);
    return {
      ticker: row.ticker,
      company: row.company,
      score: row.score,
      role: insiderSignalRoleText(row),
      nth: lead ? insiderNth(lead, row) : null,
      vsUsual: lead ? insiderUsualRatio(lead, row) : null,
      stake: lead ? insiderStakeValue(lead) : null,
      stakeBothWays: lead?.twoWay === true,
      why: insiderSignalWhy(row),
      reasons: row.reasons,
      whySignals: row.whySignals ?? null,
      insiders: row.insiders,
      buys: row.buys,
      value: row.value,
      currency: FORM4_CURRENCY,
      shares: row.shares,
      firstBuy: row.firstBuy,
      lastBuy: row.lastBuy,
      filingDate: row.lastFiled,
      marketCap: row.marketCap ?? null,
      ...row.planValue != null ? { planValue: row.planValue } : {},
      ...row.soldValue != null ? { soldValue: row.soldValue } : {},
      buyers: row.buyers.map((buyer) => {
        const stake = insiderStakeFact(buyer);
        return `${formatInsiderName(buyer.name)} (${buyer.role}) ${formatSignalValue(buyer.value)}${stake.sort == null ? "" : ` ${stake.text}`}`;
      }).join("; "),
      signals: row.signals,
    };
  });
}

const SIGNAL_OPTION_STATE = (key: string) => ({ pluginId: "ticker-research", key: `insider:signals:${key}` });

/** The ranking's query from the options; a position that belongs to the other side is an error. */
function signalQuery(options: HeadlessPaneLoadArgs["options"]): InsiderSignalsQuery {
  const side: InsiderSignalSide = options.side === "sell" ? "sell" : "buy";
  if (side === "sell" && options.new === true) throw new Error("--new is a buying filter; with --side sell, use --exited.");
  if (side === "buy" && options.exited === true) throw new Error("--exited is a selling filter; use it with --side sell.");
  const cap = typeof options.cap === "string" && options.cap !== "all" ? options.cap as InsiderSignalsQuery["cap"] : null;
  return {
    side,
    window: Number(options.window) || DEFAULT_INSIDER_SIGNALS_QUERY.window,
    role: (typeof options.role === "string" ? options.role : "all") as InsiderSignalRoleGroup,
    minValue: Number(options.minValue) || 0,
    cluster: options.cluster === true,
    position: options.new === true || options.exited === true,
    cap,
  };
}

/** What a Form 4/A says about itself, for its last row in the report. */
function amendmentNote(entry: ParsedInsiderFiling): string {
  const original = entry.disclosure?.originalFilingDate;
  return [original ? `Original filed ${original}` : "", ...buildInsiderDisclosureText(entry).split("\n")].filter(Boolean).join("\n");
}

export interface InsiderHeadlessDependencies {
  /** Daily FX closes for values in a base currency other than USD; the report's API client unless a test stands in. */
  fxHistory?: FxHistoryClient;
  loadSignals?(query: InsiderSignalsQuery, limit: number, ctx: HeadlessPaneContext): Promise<InsiderSignalsPayload>;
  loadCompany?(query: InsiderCompanyQuery, ctx: HeadlessPaneContext): Promise<InsiderCompanyActivity>;
  loadParsed(
    symbol: string,
    limit: number,
    args: HeadlessPaneLoadArgs,
    ctx: HeadlessPaneContext,
  ): Promise<InsiderFilingsLoad>;
}

const defaultDependencies: InsiderHeadlessDependencies = {
  loadSignals: async (query, limit, ctx) => (await loadInsiderSignals(query, {
    limit,
    force: ctx.refresh === true,
    client: ctx.apiClient,
    signal: ctx.signal,
  })).payload,
  loadCompany: async (query, ctx) => (await loadInsiderCompany(query, {
    force: ctx.refresh === true,
    client: ctx.apiClient,
    signal: ctx.signal,
  })).payload,
  loadParsed: (symbol, limit, _args, ctx) => loadParsedInsiderFilings(ctx.marketData, symbol, {
    limit,
    signal: ctx.signal,
  }),
};

/**
 * "CAR Group (ASX) files no SEC reports." for a listing abroad the SEC lists
 * nothing for, as `filings` says it; null for a US listing or a symbol with no
 * venue, whose empty list is only no Form 4.
 */
async function noSecReportsEmpty(ctx: HeadlessPaneContext, key: string): Promise<string | null> {
  const listing = await resolveHeadlessIssuerListing(ctx, key);
  if (!listing.exchange) return null;
  return noSecReportsNotice({ symbol: parsePublicTickerKey(key).symbol, exchange: listing.exchange, name: listing.name ?? null });
}

/**
 * What INS says for a company with no Form 4 of its own: why there is none,
 * and for a company from abroad, that its home market's insider reports are
 * not covered either ("Canadian insider reports (SEDI) not covered.").
 */
async function insiderEmpty(ctx: HeadlessPaneContext, key: string, foreignPrivateIssuer: boolean, noFilings: boolean): Promise<string> {
  const [noReports, { exchange }] = await Promise.all([
    noFilings ? noSecReportsEmpty(ctx, key) : null,
    resolveHeadlessInstrument(ctx, key),
  ]);
  const home = await loadHomeInsiderReportsNote(ctx.marketData, key, exchange, foreignPrivateIssuer);
  return noReports ? [noReports, home].filter(Boolean).join(" ") : insiderEmptyNotice(foreignPrivateIssuer, home);
}

/** At most this many tickers in one INS table: each reads its own Form 4s. */
const MAX_INSIDER_TICKERS = 10;
/** Tickers whose Form 4s are read at once. */
const INSIDER_TICKER_CONCURRENCY = 3;

const TRADES_LIMITATION = "Loaded Form 4 and Form 4/A rows are as filed, not reconciled transactions; affected aggregates are withheld.";
const INSIDERS_LIMITATION = "Every insider's open-market purchases (code P) and sales (code S): purchases under a Rule 10b5-1 plan count, their dollars under Plan Buys (the ranking leaves them out); sales under a plan, to cover tax, of shares exercised that day or in an offering do not. An insider who bought and sold is counted on the net, on one side. Each Form 4 line as filed, plan trades marked 10b5-1, is the default view.";

/** Several tickers' rows in one table: which company each row is. */
const TICKER_COLUMN: HeadlessPaneColumn = { key: "ticker", header: "Ticker" };

/** One company's Form 4 lines as filed, before any base-currency value, with what the report says of them. */
interface TickerTrades {
  rows: HeadlessPaneRow[];
  empty: string | null;
  errors: string[];
  metadata: Record<string, unknown>;
}

async function readTickerTrades(
  symbol: string,
  args: HeadlessPaneLoadArgs,
  ctx: HeadlessPaneContext,
  dependencies: InsiderHeadlessDependencies,
): Promise<TickerTrades> {
  const limit = Number(args.options.limit);
  const { parsed, foreignPrivateIssuer, noFilings } = await dependencies.loadParsed(symbol, limit, args, ctx);
  const empty = parsed.length > 0 ? null : await insiderEmpty(ctx, symbol, foreignPrivateIssuer, noFilings);
  const name = String(args.options.name ?? "").trim().toLocaleLowerCase();
  const type = isInsiderTypeFilter(args.options.type) ? args.options.type : "all";
  const owned = name
    ? parsed.filter((entry) => matchesInsiderOwner(entry, name))
    : parsed;
  const filtered = owned.filter((entry) => matchesInsiderTypeFilter(entry, type));
  const amendments = relevantInsiderAmendments(filtered, parsed);
  const incomplete = [...new Set(buildInsiderRows(parsed)
    .filter((row) => row.status !== "parsed" && row.status !== "disclosure")
    .map((row) => row.accessionNumber))];
  // A filing's lines sit together, so its note goes once, under the last of them.
  const rows: HeadlessPaneRow[] = buildInsiderRows(filtered, parsed).map((row, index) => {
    const entry = filtered[index]!;
    const last = filtered[index + 1]?.filing.accessionNumber !== entry.filing.accessionNumber;
    return isAmendedInsiderFiling(entry) && last ? { ...row, note: amendmentNote(entry) || null } : row;
  });
  return {
    rows,
    empty,
    errors: [
      ...incomplete.map((accessionNumber) => `${accessionNumber}: Form 4 transactions are unavailable or incomplete.`),
      ...amendments.map((scope) => `${scope.accessionNumber}: Form 4/A is unreconciled; affected transaction totals are unavailable.`),
    ],
    metadata: {
      symbol,
      summary: buildInsiderSummary(owned, Date.now(), parsed),
      amendments,
      foreignPrivateIssuer,
      parsed: new Set(parsed.filter(({ transaction }) => transaction != null).map(({ filing }) => filing.accessionNumber)).size,
      transactions: filtered.filter(({ transaction }) => transaction != null).length,
      requested: limit,
      name: name || null,
      type,
    },
  };
}

async function tickerTrades(
  symbol: string,
  args: HeadlessPaneLoadArgs,
  ctx: HeadlessPaneContext,
  dependencies: InsiderHeadlessDependencies,
): Promise<HeadlessRowsResult> {
  const read = await readTickerTrades(symbol, args, ctx, dependencies);
  // Every value says its currency; a base currency other than USD gets each value converted beside it.
  const based = await withInsiderBaseValues(read.rows, ctx.config.baseCurrency, dependencies.fxHistory ?? ctx.apiClient);
  return {
    ...(based.columns ? { columns: withMoneyColumns(based.columns) } : {}),
    ...(based.note ? { notes: [based.note] } : {}),
    rows: based.rows,
    // Nothing at all: the company has no Form 4 of its own, which is the whole answer.
    ...(read.empty ? { empty: read.empty, unavailableSymbols: [] } : {}),
    errors: read.errors,
    metadata: { ...read.metadata, limitations: [TRADES_LIMITATION] },
  };
}

/** One company's insiders over the window, as the ranking counts them, with the coverage notices of its lists. */
async function readTickerInsiders(
  symbol: string,
  args: HeadlessPaneLoadArgs,
  ctx: HeadlessPaneContext,
  dependencies: InsiderHeadlessDependencies,
): Promise<TickerTrades & { notices: string[] }> {
  const { window, side } = signalQuery(args.options);
  const ticker = parsePublicTickerKey(symbol).symbol;
  const activity = await (dependencies.loadCompany ?? defaultDependencies.loadCompany!)({ ticker, window }, ctx);
  const notices = [...new Set([activity.buy, activity.sell]
    .map((payload) => insiderSignalsCoverageNotice(payload, { subject: "this list" }))
    .filter((notice): notice is string => !!notice))];
  const rows = insidersRows(activity, side);
  return {
    rows,
    empty: rows.length === 0 ? insiderActivityEmptyTitle(window) : null,
    errors: [],
    notices,
    metadata: {
      symbol,
      window,
      through: activity.buy.through,
      asOf: activity.buy.asOf,
      coverage: { buy: activity.buy.coverage, sell: activity.sell.coverage },
    },
  };
}

async function tickerInsiders(
  symbol: string,
  args: HeadlessPaneLoadArgs,
  ctx: HeadlessPaneContext,
  dependencies: InsiderHeadlessDependencies,
): Promise<HeadlessRowsResult> {
  const read = await readTickerInsiders(symbol, args, ctx, dependencies);
  const table = await insidersTable(read.rows, ctx, dependencies);
  return {
    columns: table.columns,
    rows: table.rows,
    ...(table.notes.length ? { notes: table.notes } : {}),
    ...(read.empty ? { empty: read.empty } : {}),
    metadata: {
      ...read.metadata,
      ...(read.notices.length ? { notices: read.notices } : {}),
      limitations: [INSIDERS_LIMITATION],
    },
  };
}

/** `--watchlist <name>`: its tickers as saved, the first MAX_INSIDER_TICKERS, and the line that says so. */
async function watchlistTickers(name: string, ctx: HeadlessPaneContext): Promise<{ symbols: string[]; note: string }> {
  const watchlist = findNamedCollection(ctx.config.watchlists, name);
  if (!watchlist) {
    throw new Error(ctx.config.watchlists.length
      ? `No watchlist named "${name}". Watchlists: ${describeCollections(ctx.config.watchlists)}.`
      : `No watchlist named "${name}". No watchlists are set up.`);
  }
  const members = (await ctx.resolveWatchlist?.(watchlist.id)) ?? [];
  if (members.length === 0) throw new Error(`Watchlist ${watchlist.name} holds no tickers.`);
  return readWatchlistArgument(name, watchlist, members.map((member) => watchlistMemberSymbol(member.metadata)), MAX_INSIDER_TICKERS);
}

/**
 * INS on several tickers, typed or a watchlist's: one table, the Ticker
 * column first and each company's rows together in the order given, as INS
 * on each would list them. A company with nothing, or whose filings cannot
 * be read, is named in a note; when none has anything, that is the answer.
 */
async function severalTickers(
  symbols: readonly string[],
  watchlistNote: string | null,
  args: HeadlessPaneLoadArgs,
  ctx: HeadlessPaneContext,
  dependencies: InsiderHeadlessDependencies,
): Promise<HeadlessRowsResult> {
  const insiders = args.options.view === "insiders";
  const reads = await mapWithConcurrency(symbols, INSIDER_TICKER_CONCURRENCY, async (symbol) => {
    try {
      return { symbol, read: insiders ? await readTickerInsiders(symbol, args, ctx, dependencies) : await readTickerTrades(symbol, args, ctx, dependencies) };
    } catch (error) {
      ctx.signal.throwIfAborted();
      return { symbol, failure: error instanceof Error ? error.message : String(error) };
    }
  });
  const read = reads.flatMap((entry) => "read" in entry && entry.read ? [{ symbol: entry.symbol, ...entry.read }] : []);
  const failures = reads.flatMap((entry) => "failure" in entry && entry.failure ? [`${entry.symbol}: ${entry.failure}`] : []);
  if (read.length === 0) throw new Error(failures.join("\n"));
  const rows = read.flatMap((entry) => entry.rows.map((row) => ({ ticker: entry.symbol, ...row })));
  const empties = read.flatMap((entry) => entry.empty ? [`${entry.symbol}: ${entry.empty}`] : []);
  const notices = [...new Set(read.flatMap((entry) => "notices" in entry ? entry.notices as string[] : []))];
  const tickers = Object.fromEntries(read.map((entry) => [entry.symbol, entry.metadata]));
  const shared = {
    symbols: [...symbols],
    ...(watchlistNote ? { watchlist: String(args.options.watchlist).trim() } : {}),
    tickers,
    ...(notices.length ? { notices } : {}),
  };
  const lead = [...(watchlistNote ? [watchlistNote] : []), ...failures];
  if (insiders) {
    const table = await insidersTable(rows, ctx, dependencies);
    const notes = [...lead, ...(rows.length ? empties : []), ...table.notes];
    return {
      columns: [TICKER_COLUMN, ...table.columns],
      rows: table.rows,
      ...(rows.length === 0 ? { empty: empties.join("\n") } : {}),
      ...(notes.length ? { notes } : {}),
      metadata: { ...shared, limitations: [INSIDERS_LIMITATION] },
    };
  }
  const based = await withInsiderBaseValues(rows, ctx.config.baseCurrency, dependencies.fxHistory ?? ctx.apiClient);
  const notes = [...lead, ...(rows.length ? empties : []), ...(based.note ? [based.note] : [])];
  return {
    columns: [TICKER_COLUMN, ...(based.columns ? withMoneyColumns(based.columns) : INSIDER_COLUMNS)],
    rows: based.rows,
    ...(rows.length === 0 ? { empty: empties.join("\n"), unavailableSymbols: [] } : {}),
    ...(notes.length ? { notes } : {}),
    errors: read.flatMap((entry) => entry.errors.map((error) => `${entry.symbol} ${error}`)),
    metadata: { ...shared, limitations: [TRADES_LIMITATION] },
  };
}

export function createInsiderHeadless(
  dependencies: InsiderHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    freshness: { ...SEC_FILING_ROWS, basis: "Form 4 filings" },
    argument: {
      kind: "tickers",
      optional: true,
      maximum: MAX_INSIDER_TICKERS,
      placeholder: "ticker",
      description: "US equity ticker, or several in one table with a Ticker column; omit for the companies whose insiders are buying, or selling, in the open market.",
    },
    options: [
      {
        key: "watchlist",
        description: `A watchlist's tickers, the first ${MAX_INSIDER_TICKERS}, in one table with a Ticker column, as typing them would.`,
        type: "string",
        defaultValue: "",
        placeholder: "name",
        shot: { reportOnly: "reads a watchlist's tickers into one table" },
      },
      {
        key: "name",
        description: "Exact reporting owner name.",
        type: "string",
        defaultValue: "",
      },
      {
        key: "type",
        description: "Transaction types: trades (open-market buys and sells, what the pane opens on), other (awards, exercises, tax, gifts), or all. Without it, every line.",
        type: "enum",
        values: [
          { value: "trades", aliases: ["buys-sells", "buys", "sells"] },
          { value: "other" },
          { value: "all" },
        ],
        pluginState: { pluginId: "ticker-research", key: "insider:typeFilter" },
      },
      {
        key: "limit",
        shot: REPORT_ROWS,
        aliases: ["count", "rows"],
        description: "Maximum of the company's own Form 4 and Form 4/A filings to parse; without a ticker, companies to rank.",
        type: "integer",
        defaultValue: INSIDER_REPORT_FILINGS,
        minimum: 1,
        maximum: 100,
      },
      {
        key: "window",
        aliases: ["days"],
        description: "Without a ticker: days of open-market buying or selling to rank, 1 to 90; with --view insiders, the days its insiders cover.",
        type: "integer",
        defaultValue: 30,
        minimum: 1,
        maximum: 90,
        pluginState: SIGNAL_OPTION_STATE("window"),
      },
      {
        key: "side",
        description: "Buying (open-market purchases) or selling (sales an insider chose: not under a Rule 10b5-1 plan, to cover tax, out of an option exercise or in an offering). Without a ticker, the side to rank; with --view insiders, the side whose dollars sort first.",
        type: "enum",
        defaultValue: "buy",
        values: [
          { value: "buy", aliases: ["buys", "buying", "purchases"] },
          { value: "sell", aliases: ["sells", "selling", "sales"] },
        ],
        example: "--side sell --min-value 250000",
        exampleWithoutArgument: true,
        pluginState: SIGNAL_OPTION_STATE("side"),
      },
      {
        key: "role",
        description: "Without a ticker: whose trades to rank: all, officers (CEO, CFO and other officers), directors or owners (10% owners).",
        type: "enum",
        defaultValue: "all",
        values: [
          { value: "all" },
          { value: "officers", aliases: ["officer", "executives"] },
          { value: "directors", aliases: ["director"] },
          { value: "owners", aliases: ["owner", "10%"] },
        ],
        example: "--role directors --cluster --window 90",
        exampleWithoutArgument: true,
        pluginState: SIGNAL_OPTION_STATE("role"),
      },
      {
        key: "minValue",
        aliases: ["min-value", "min"],
        description: "Without a ticker: least US dollars a company's insiders traded in the window.",
        type: "integer",
        minimum: 0,
        pluginState: SIGNAL_OPTION_STATE("minValue"),
      },
      {
        key: "cluster",
        description: "Without a ticker: only companies where two insiders or more traded within a few weeks.",
        type: "boolean",
        pluginState: SIGNAL_OPTION_STATE("cluster"),
      },
      {
        key: "new",
        description: "Without a ticker, buying: only companies where an insider opened a new position.",
        type: "boolean",
        pluginState: SIGNAL_OPTION_STATE("position"),
      },
      {
        key: "exited",
        description: "Without a ticker, with --side sell: only companies where an insider sold their whole stake.",
        type: "boolean",
        example: "--side sell --exited",
        exampleWithoutArgument: true,
        pluginState: SIGNAL_OPTION_STATE("position"),
      },
      {
        key: "view",
        description: "With a ticker: trades (each Form 4 line as filed, the default) or insiders (one row per insider over --window, as the ranking counts them: nth trade, size against usual, stake, dollars bought or sold; --side sell lists the largest sellers first).",
        type: "enum",
        defaultValue: "trades",
        values: [
          { value: "trades", aliases: ["transactions"] },
          { value: "insiders", aliases: ["insider"] },
        ],
        example: "--view insiders --window 90",
        pluginState: { pluginId: "ticker-research", key: "insider:view" },
      },
      {
        key: "cap",
        description: "Without a ticker: market value, micro (under $300M), small ($300M to $2B), mid ($2B to $10B) or large; where the server stores market values.",
        type: "enum",
        values: INSIDER_SIGNAL_CAP_OPTIONS.map((option) => ({ value: option.value })),
        pluginState: SIGNAL_OPTION_STATE("cap"),
      },
    ],
    columns: INSIDER_COLUMNS,
    // The Trades view filters by insider as the pane's own filter does, kept by ticker.
    shotState: (args, _load, given) => {
      const name = String(args.options.name ?? "").trim();
      if (!given.has("name") || !name) return {};
      const symbol = args.symbols[0];
      if (!symbol || args.options.view === "insiders") {
        throw new Error(symbol
          ? `--name filters ${symbol}'s trades, not its insiders. Drop --view insiders or --name from shot.`
          : `--name filters one company's trades: gloom shot INS <ticker> --name ${JSON.stringify(name)}`);
      }
      return { pluginState: { "ticker-research": { [`insider:nameFilter:${parsePublicTickerKey(symbol).symbol}`]: name } } };
    },
    describe: (args) => {
      const watchlist = String(args.options.watchlist ?? "").trim();
      const subject = watchlist ? `watchlist ${watchlist}` : args.symbols.join(", ");
      if (subject) return args.options.view === "insiders" ? `Insiders | ${subject}` : `Insider Transactions | ${subject}`;
      return `${INSIDER_SIGNALS_TITLE} | ${args.options.side === "sell" ? "Selling" : "Buying"}`;
    },
    async load(args, ctx) {
      const watchlist = String(args.options.watchlist ?? "").trim();
      if (watchlist && args.symbols.length > 0) throw new Error("Give tickers or --watchlist, not both.");
      const read = watchlist ? await watchlistTickers(watchlist, ctx) : null;
      const symbols = read?.symbols ?? args.symbols;
      if (symbols.length > 1 || read) return severalTickers(symbols, read?.note ?? null, args, ctx, dependencies);
      const symbol = symbols[0];
      if (!symbol) {
        const query = signalQuery(args.options);
        const payload = await (dependencies.loadSignals ?? defaultDependencies.loadSignals!)(query, Number(args.options.limit), ctx);
        const side = payload.side ?? "buy";
        const words = insiderSideWords(side);
        // A server that predates plan buys and sales beside them sends neither: no column of dashes.
        const columns = signalColumns(side).filter((column) => (column.key !== "planValue" && column.key !== "soldValue")
          || payload.rows.some((row) => row[column.key as "planValue" | "soldValue"] != null));
        // A base currency other than USD gets the side's dollars in it too, as the trades' table gets each value.
        const based = await withDayBaseValues(signalRows(payload), [{ key: "value", header: words.traded }], "lastBuy",
          ctx.config.baseCurrency, dependencies.fxHistory ?? ctx.apiClient);
        const labelled = withBaseColumns(labelDollarColumns(columns, ["value", "planValue", "soldValue"], ctx.config.baseCurrency), based.columns);
        const plans = side === "buy" && payload.rows.some((row) => row.planValue != null);
        const notes = [
          ...based.columns ? [`${words.traded} (${ctx.config.baseCurrency.trim().toUpperCase()}) is each company's dollars at the ${String(based.rows[0]?.fxPair)} daily close of its ${words.last.toLowerCase()} day, or of the trading day before it; ${String(based.rows[0]?.fxPair)} is that rate.`] : [],
          ...based.note ? [based.note] : [],
          ...plans ? ["Plan Buys, under a Rule 10b5-1 plan, are left out of the score; Sold counts plan sales, not those to cover tax, of exercised shares or in an offering."] : [],
        ];
        return {
          columns: labelled,
          // The exports carry each row's insiders; the text leaves them to fn INS <ticker> --view insiders.
          textColumns: labelled.filter((column) => column.key !== "buyers"),
          ...(notes.length ? { notes } : {}),
          rows: based.rows,
          ...(payload.rows.length === 0 ? { empty: insiderSignalsEmptyTitle(payload.window, side, insiderSignalsFiltered(query)) } : {}),
          metadata: {
            side,
            window: payload.window,
            filters: payload.filters ?? null,
            marketCaps: payload.marketCaps ?? null,
            through: payload.through,
            asOf: payload.asOf,
            coverage: payload.coverage,
            limitations: [
              side === "sell"
                ? "Open-market sales (Form 4 code S) an officer, director or 10% owner chose to make only: sales under a Rule 10b5-1 plan, to cover tax, of shares exercised that day, in an offering, into a deal or in a private sale are left out, as are forms a company files as an owner of another issuer."
                : "Open-market purchases (Form 4 code P) an officer, director or 10% owner chose to make: purchases under a Rule 10b5-1 plan are left out of the score and shown apart (planValue), beside every open-market sale in the window (soldValue); forms a company files as an owner of another issuer are left out.",
              ...(query.cap && payload.marketCaps === "unavailable" ? ["The server stores no market values, so the cap filter leaves nothing."] : []),
            ],
          },
        };
      }
      return args.options.view === "insiders"
        ? tickerInsiders(symbol, args, ctx, dependencies)
        : tickerTrades(symbol, args, ctx, dependencies);
    },
  };
}

export const insiderHeadless = createInsiderHeadless();
