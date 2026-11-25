import type { MnaDeal, MnaDealsParams, MnaDealsPayload, MnaOutsideDate, MnaRegionFilter, MnaStatusFilter, MnaTargetFilter } from "../../../api-client/mna";
import type { HeadlessPaneColumn, HeadlessPaneContext, HeadlessPaneDefinition } from "../../../types/plugin";
import type { Quote } from "../../../types/financials";
import { appendMnaDeals, fetchMnaDeals } from "./client";
import { companyDataNotes } from "../../../types/company-from";
import {
  apartText,
  closeBasisLabel,
  dealSpread,
  dealsSymbol,
  formatDealValue,
  formatExpectedClose,
  formatPercentShort,
  isMnaTermsView,
  legsApart,
  mnaTermsView,
  outsideDateParts,
  printWhen,
  stageLabel,
  termsLabel,
  type DealSpread,
  type MnaTermsView,
  type SpreadBasis,
} from "./model";
import { REPORT_ROWS } from "../shared/headless-options";
import { formatUtcTime } from "../../../utils/utc-time";
import { MISSING_VALUE } from "../../../utils/format";

const text = (value: unknown) => (typeof value === "string" ? value : "");

const percent = (value: unknown) => (typeof value === "number" ? formatPercentShort(value) : MISSING_VALUE);

/**
 * What a spread's prices are, as the report says it: a session's closes
 * dated in full (`Mon 16 Nov close`), or the older trade's time in UTC after
 * its session when that is not the regular one, or how far apart two trades
 * are too far apart to be one moment's (`trades 8h apart`).
 */
function reportBasisText(basis: SpreadBasis): string {
  if (basis.kind === "close") return closeBasisLabel(basis.session, Date.now(), { dated: true });
  if (legsApart(basis)) return `trades ${apartText(basis.apartMs!)} apart`;
  return basis.at == null ? MISSING_VALUE : printWhen(basis.at, basis.session, formatUtcTime);
}

const ANNOUNCED: HeadlessPaneColumn = { key: "announced", header: "Announced" };
const TARGET: HeadlessPaneColumn = { key: "target", header: "Target" };
const SYMBOL: HeadlessPaneColumn = { key: "targetSymbol", header: "Symbol" };
const ACQUIRER: HeadlessPaneColumn = { key: "acquirer", header: "Acquirer" };
const TERMS: HeadlessPaneColumn = { key: "terms", header: "Terms" };
const VALUE: HeadlessPaneColumn = { key: "value", header: "Value", align: "right" };
const STAGE: HeadlessPaneColumn = { key: "stage", header: "Stage" };
const CLOSE: HeadlessPaneColumn = { key: "expectedClose", header: "Close", format: (value) => formatExpectedClose(text(value) || null) };
const CLOSED: HeadlessPaneColumn = { key: "closed", header: "Closed" };
// A pending listed deal's spread, at the prices `spreadAsOf` names; the latest trades' beside a close.
const SPREAD: HeadlessPaneColumn = { key: "spread", header: "Spread", align: "right", format: percent, exportLast: true };
const SPREAD_AS_OF: HeadlessPaneColumn = { key: "spreadAsOf", header: "As of", exportLast: true };
const LATEST: HeadlessPaneColumn = {
  key: "latestSpread", header: "Latest", align: "right", format: percent, exportLast: true,
  textFormat: (value, row) => typeof value === "number" ? `${percent(value)} (${text(row.latestAsOf)})` : MISSING_VALUE,
};
const LATEST_AS_OF: HeadlessPaneColumn = { key: "latestAsOf", header: "Latest as of", exportLast: true };
// The agreement's deadline as a filing states it, with the later one it moves to.
const OUTSIDE: HeadlessPaneColumn = {
  key: "outsideDate", header: "Outside", exportLast: true,
  format: (value) => {
    if (!value || typeof value !== "object") return MISSING_VALUE;
    const outside = outsideDateParts(value as MnaOutsideDate);
    return outside.extension ? `${outside.date}, ${outside.extension}` : outside.date;
  },
};

/**
 * CSV and NDJSON keep the columns an earlier export had where they were; the
 * spread's and the outside date's come after them (`exportLast`).
 */
const COLUMNS: HeadlessPaneColumn[] = [
  ANNOUNCED, TARGET, SYMBOL, ACQUIRER, TERMS, VALUE, STAGE, CLOSE, CLOSED,
  SPREAD, SPREAD_AS_OF, LATEST, LATEST_AS_OF, OUTSIDE,
];
/** The text report reads the spread beside the terms it prices, its latest trades' basis in its cell. */
const TEXT_COLUMNS: HeadlessPaneColumn[] = [
  ANNOUNCED, TARGET, SYMBOL, ACQUIRER, TERMS, VALUE, SPREAD, SPREAD_AS_OF, LATEST, STAGE, CLOSE, OUTSIDE, CLOSED,
];

/** A deal with no per-share terms has no spread: its rows end at the stage and the dates, as the pane's No terms list does. */
const SPREAD_KEYS = new Set([SPREAD.key, SPREAD_AS_OF.key, LATEST.key, LATEST_AS_OF.key]);
const withoutSpread = (columns: HeadlessPaneColumn[]) => columns.filter((column) => !SPREAD_KEYS.has(column.key));

/** Pages read to find `--terms` rows, which the server does not filter by: a page holds up to 100 deals. */
const TERMS_PAGES = 5;

/**
 * The deals `--terms` keeps, read page after page until `limit` of them are
 * in or the list ends; without it, the one page asked for.
 */
async function loadDeals(params: MnaDealsParams, terms: MnaTermsView | null, ctx: HeadlessPaneContext): Promise<MnaDealsPayload> {
  if (!terms) return fetchMnaDeals(params, ctx.apiClient);
  const limit = params.limit ?? 50;
  let payload = await fetchMnaDeals({ ...params, limit: 100 }, ctx.apiClient);
  for (let page = 1; page < TERMS_PAGES && payload.hasMore && payload.deals.filter((deal) => mnaTermsView(deal) === terms).length < limit; page += 1) {
    payload = appendMnaDeals(payload, await fetchMnaDeals({ ...params, limit: 100, offset: payload.nextOffset }, ctx.apiClient));
  }
  const kept = payload.deals.filter((deal) => mnaTermsView(deal) === terms);
  return { ...payload, deals: kept.slice(0, limit), hasMore: payload.hasMore || kept.length > limit };
}

/** The quotes of the listings pending deals' spreads are priced at, by symbol; none when the batch fails or is not offered. */
async function legQuotes(deals: readonly MnaDeal[], ctx: HeadlessPaneContext): Promise<Map<string, Quote>> {
  const symbols = new Set<string>();
  for (const deal of deals) {
    if (deal.status !== "pending" || !deal.target.symbol) continue;
    symbols.add(deal.target.symbol);
    if (deal.terms.exchangeRatio != null && deal.terms.ratioSymbol) symbols.add(deal.terms.ratioSymbol);
  }
  const provider = ctx.marketData;
  if (!provider?.getQuotesBatch || symbols.size === 0) return new Map();
  try {
    const results = await provider.getQuotesBatch([...symbols].map((symbol) => ({ symbol, exchange: "" })), { forceRefresh: ctx.refresh, signal: ctx.signal });
    return new Map(results.flatMap((result) => result.quote ? [[result.target.symbol, result.quote] as const] : []));
  } catch {
    // Intentional ignore: the deals still list without spreads when the quotes do not come.
    return new Map();
  }
}

/** A row's spread fields: the spread and its basis, the latest trades' beside a close, and each leg's print. */
function spreadFields(spread: DealSpread | null): Record<string, unknown> {
  if (!spread) return { spread: null, spreadAsOf: null, latestSpread: null, latestAsOf: null, legs: [] };
  return {
    spread: spread.spread,
    spreadAsOf: reportBasisText(spread.basis),
    spreadBasis: spread.basis,
    offerValue: spread.offer,
    latestSpread: spread.latest?.spread ?? null,
    latestAsOf: spread.latest ? reportBasisText(spread.latest.basis) : null,
    legs: spread.legs.map((entry) => ({ symbol: entry.symbol, price: entry.price, at: entry.at == null ? null : new Date(entry.at).toISOString(), session: entry.session })),
  };
}

/**
 * What a company's empty deal list says: the pane's "No deals involving X.",
 * with the status and search asked for. Newer deals a free account waits for
 * are the report's Pro line.
 */
function emptyDealsText(symbol: string, params: MnaDealsParams): string {
  const status = params.status && params.status !== "all" ? `${params.status} ` : "";
  const query = params.query ? ` matching "${params.query}"` : "";
  return `No ${status}deals involving ${symbol}${query}.`;
}

export const mnaHeadless: HeadlessPaneDefinition<"rows"> = {
  shape: "rows",
  freshness: { status: "not-a-feed", basis: "reported deals" },
  argument: {
    kind: "ticker",
    optional: true,
    description: "Optional ticker: deals where it is the target or the buyer.",
  },
  discovery: {
    aliases: ["MA"],
    dataRequirements: ["Gloom Cloud M&A deals read from news stories, press releases and SEC filings"],
    limitations: [
      "Free accounts see deals 7 days after they were first reported.",
      "A spread is at the legs' closes of one session while a venue is out of its regular session, at their last trades in it; As of says which, and Latest gives the trades since a close.",
      "A private or non-US deal completes only when a story reports it.",
    ],
  },
  options: [
    { key: "status", description: "Deal status.", type: "enum", defaultValue: "pending", values: ["pending", "talks", "completed", "terminated", "all"].map((value) => ({ value })) },
    { key: "target", description: "Public or private targets.", type: "enum", defaultValue: "public", values: ["all", "public", "private"].map((value) => ({ value })) },
    { key: "region", description: "US or international targets.", type: "enum", defaultValue: "all", values: ["all", "us", "intl"].map((value) => ({ value })) },
    {
      key: "terms",
      description: "Deals with per-share cash or shares (priced, the ones a spread is read on) or announced without them (unpriced), as the pane's Terms lists split pending deals.",
      type: "enum",
      values: [{ value: "priced" }, { value: "unpriced", aliases: ["none", "no-terms"] }],
    },
    { key: "query", shot: { reportOnly: "searches the text report, and the pane opens without a search" }, description: "Company name or ticker.", type: "string" },
    { key: "limit", shot: REPORT_ROWS, aliases: ["count", "rows"], description: "Maximum rows.", type: "integer", defaultValue: 50, minimum: 1, maximum: 100 },
  ],
  describe: (args) => `M&A${args.symbols[0] ? ` | ${args.symbols[0]}` : ""} | ${text(args.options.status) || "pending"}${
    args.options.terms === "priced" ? " | priced" : args.options.terms === "unpriced" ? " | no terms" : ""}`,
  // The filters the pane keeps, as asked for; one company's deals keep their status apart and have no target or region filter.
  shotState: (args, _load, given) => {
    const symbol = args.symbols[0];
    const unused = symbol ? ["target", "region"].filter((key) => given.has(key)) : [];
    if (unused.length) {
      throw new Error(`One company's deals have no ${unused.map((key) => `--${key}`).join(" or ")} filter. Drop it from shot, or leave out ${symbol} for the market's deals.`);
    }
    const prefix = symbol ? "ticker." : "";
    const state = Object.fromEntries(["status", "target", "region", "terms"].filter((key) => given.has(key)).map((key) => [`${prefix}${key}`, args.options[key]]));
    return Object.keys(state).length ? { pluginState: { "ticker-research": state } } : {};
  },
  async load(args, ctx) {
    const symbol = args.symbols[0];
    // A listing abroad (ATH:TSX) asks by the quote symbol its deals are filed under (ATH.TO), as the pane does.
    const filed = symbol ? dealsSymbol(symbol) : "";
    const params: MnaDealsParams = {
      status: ((args.options.status as MnaStatusFilter | undefined) ?? (symbol ? "all" : "pending")),
      target: symbol ? undefined : (args.options.target as MnaTargetFilter | undefined),
      region: symbol ? undefined : (args.options.region as MnaRegionFilter | undefined),
      symbol: filed || undefined,
      query: text(args.options.query) || undefined,
      limit: Number(args.options.limit ?? 50),
    };
    const terms = isMnaTermsView(args.options.terms) ? args.options.terms : null;
    const payload = await loadDeals(params, terms, ctx);
    const quotes = await legQuotes(payload.deals, ctx);
    const spreadOf = (deal: MnaDeal) => quotes.size === 0 || !deal.target.symbol ? null
      : dealSpread(deal, quotes.get(deal.target.symbol) ?? null, deal.terms.ratioSymbol ? quotes.get(deal.terms.ratioSymbol) ?? null : null);
    // No deal involving a company is the list's answer for it, as the pane says, never a company MA does not cover.
    const none = payload.deals.length === 0 && symbol
      ? { empty: emptyDealsText(filed || symbol, params), unavailableSymbols: [] }
      : {};
    return {
      ...none,
      columns: terms === "unpriced" ? withoutSpread(COLUMNS) : COLUMNS,
      textColumns: terms === "unpriced" ? withoutSpread(TEXT_COLUMNS) : TEXT_COLUMNS,
      rows: payload.deals.map((deal) => ({
        id: deal.id,
        announced: deal.announced,
        target: deal.target.name,
        targetSymbol: deal.target.symbol,
        targetCountry: deal.target.country,
        acquirer: deal.acquirer?.name ?? null,
        acquirerSymbol: deal.acquirer?.symbol ?? null,
        status: deal.status,
        stage: stageLabel(deal),
        terms: termsLabel(deal.terms),
        cashPerShare: deal.terms.cashPerShare,
        exchangeRatio: deal.terms.exchangeRatio,
        ratioSymbol: deal.terms.ratioSymbol,
        election: deal.terms.election === true,
        currency: deal.terms.currency,
        value: formatDealValue(deal.value, deal.valueCurrency),
        valueUsd: deal.valueUsd,
        expectedClose: deal.expectedClose,
        outsideDate: deal.outsideDate ?? null,
        closed: deal.closed,
        headline: deal.headline,
        ...spreadFields(spreadOf(deal)),
      })),
      errors: payload.lockedDeals > 0 ? [`${payload.lockedDeals} deals from the last ${payload.delayDays} days need Gloom Pro`] : [],
      ...(payload.companyFrom ? { notes: companyDataNotes(payload.companyFrom) } : {}),
      metadata: {
        asOf: payload.asOf, access: payload.access, delayDays: payload.delayDays, hasMore: payload.hasMore,
      },
    };
  },
};
