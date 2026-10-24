import type {
  HeadlessPaneColumn,
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
  HeadlessPaneRow,
} from "../../../types/plugin";
import { formatCompact, formatCurrency } from "../../../utils/format";
import { INSIDER_REPORT_FILINGS, loadParsedInsiderFilings, type InsiderFilingsLoad } from "./client";
import { insiderEmptyNotice, loadHomeInsiderReportsNote } from "./issuer";
import { FORM4_CURRENCY, withInsiderBaseValues } from "./base-values";
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
import { formatInsiderName } from "./display";
import { SEC_FILINGS } from "../shared/report-freshness";
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
import type { FxHistoryClient } from "../../../market-data/fx-closes";

const INSIDER_COLUMNS: HeadlessPaneColumn[] = [
  { key: "form", header: "Form" },
  {
    key: "filingDate",
    header: "Filed",
    format: (value) => typeof value === "string" ? value.slice(0, 10) : "-",
  },
  {
    key: "transactionDate",
    header: "Tx",
    format: (value) => typeof value === "string" ? value.slice(0, 10) : "-",
  },
  {
    key: "insider",
    header: "Insider",
    format: (value) => typeof value === "string" ? formatInsiderName(value) : "-",
  },
  { key: "title", header: "Title" },
  { key: "security", header: "Security" },
  {
    key: "side",
    header: "Side",
    // A filing without transaction lines, matching the pane's "Form 4 disclosure" row.
    format: (value, row) => typeof value === "string" ? value : row.status === "disclosure" ? "DISCLOSURE" : "-",
  },
  {
    key: "shares",
    header: "Shares",
    align: "right",
    format: (value) => value == null ? "-" : formatCompact(Number(value)),
  },
  {
    key: "pricePerShare",
    header: "Price",
    align: "right",
    format: (value) => value == null ? "-" : formatCurrency(Number(value)),
  },
  {
    key: "totalValue",
    header: "Value",
    align: "right",
    format: (value) => value == null ? "-" : `$${formatCompact(Number(value))}`,
  },
  // An amendment's original date, remarks and footnotes, under the amendment's own row.
  { key: "note", header: "Note", underRow: true, format: (value) => typeof value === "string" ? value : "" },
];

/** With a base currency other than USD, the dollar columns say they are in USD ("Bought (USD)"), as $ alone is several currencies' sign. */
function labelDollarColumns(columns: HeadlessPaneColumn[], keys: readonly string[], baseCurrency: string): HeadlessPaneColumn[] {
  if (baseCurrency.trim().toUpperCase() === FORM4_CURRENCY) return columns;
  return columns.map((column) => keys.includes(column.key) ? { ...column, header: `${column.header} (${FORM4_CURRENCY})` } : column);
}

/** The trades' columns with the money ones labelled by currency and the converted value and rate after them (`withInsiderBaseValues`). */
function withMoneyColumns(money: readonly HeadlessPaneColumn[]): HeadlessPaneColumn[] {
  const byKey = new Map(money.map((column) => [column.key, column]));
  return INSIDER_COLUMNS.flatMap((column) => column.key === "totalValue"
    ? money.filter((entry) => entry.key !== "pricePerShare")
    : [byKey.get(column.key) ?? column]);
}

const figureOrDash = (value: unknown) => (typeof value === "number" ? value : null);

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
    { key: "value", header: words.traded, align: "right", format: (value) => typeof value === "number" ? formatSignalValue(value) : "-" },
    { key: "lastBuy", header: words.last, format: (value) => typeof value === "string" ? formatSignalDay(value) : "-" },
    { key: "filingDate", header: "Filed", stackPriority: 1, format: (value) => typeof value === "string" ? value : "-" },
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
  { key: "bought", header: "Bought", align: "right", format: (value) => typeof value === "number" ? formatSignalValue(value) : "--" },
  { key: "sold", header: "Sold", align: "right", format: (value) => typeof value === "number" ? formatSignalValue(value) : "--" },
  { key: "last", header: "Last", stackPriority: 1, format: (value) => typeof value === "string" ? formatSignalDay(value) : "--" },
];

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

export function createInsiderHeadless(
  dependencies: InsiderHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    freshness: { ...SEC_FILINGS, basis: "Form 4 filings", observedKey: "filingDate" },
    argument: {
      kind: "ticker",
      optional: true,
      placeholder: "ticker",
      description: "US equity ticker; omit for the companies whose insiders are buying, or selling, in the open market.",
    },
    options: [
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
      const symbol = args.symbols[0];
      if (symbol) return args.options.view === "insiders" ? `Insiders | ${symbol}` : `Insider Transactions | ${symbol}`;
      return `${INSIDER_SIGNALS_TITLE} | ${args.options.side === "sell" ? "Selling" : "Buying"}`;
    },
    async load(args, ctx) {
      const symbol = args.symbols[0];
      if (!symbol) {
        const query = signalQuery(args.options);
        const payload = await (dependencies.loadSignals ?? defaultDependencies.loadSignals!)(query, Number(args.options.limit), ctx);
        const side = payload.side ?? "buy";
        return {
          columns: labelDollarColumns(signalColumns(side), ["value"], ctx.config.baseCurrency),
          // The exports carry each row's insiders; the text leaves them to fn INS <ticker> --view insiders.
          textColumns: labelDollarColumns(signalColumns(side).filter((column) => column.key !== "buyers"), ["value"], ctx.config.baseCurrency),
          rows: signalRows(payload),
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
                : "Open-market purchases (Form 4 code P) by officers, directors and 10% owners only; forms a company files as an owner of another issuer are left out.",
              ...(query.cap && payload.marketCaps === "unavailable" ? ["The server stores no market values, so the cap filter leaves nothing."] : []),
            ],
          },
        };
      }
      if (args.options.view === "insiders") {
        const { window, side } = signalQuery(args.options);
        const ticker = parsePublicTickerKey(symbol).symbol;
        const activity = await (dependencies.loadCompany ?? defaultDependencies.loadCompany!)({ ticker, window }, ctx);
        const notices = [...new Set([activity.buy, activity.sell]
          .map((payload) => insiderSignalsCoverageNotice(payload, { subject: "this list" }))
          .filter((notice): notice is string => !!notice))];
        const rows = insidersRows(activity, side);
        return {
          columns: labelDollarColumns(INSIDERS_COLUMNS, ["bought", "sold"], ctx.config.baseCurrency),
          rows,
          ...(rows.length === 0 ? { empty: insiderActivityEmptyTitle(window) } : {}),
          metadata: {
            symbol,
            window,
            through: activity.buy.through,
            asOf: activity.buy.asOf,
            coverage: { buy: activity.buy.coverage, sell: activity.sell.coverage },
            ...(notices.length ? { notices } : {}),
            limitations: [
              "Open-market purchases (code P) and the sales an insider chose to make (code S, not under a Rule 10b5-1 plan, to cover tax, of shares exercised that day or in an offering), as the ranking counts them: an insider who bought and sold is counted on the net, on one side. Each Form 4 line as filed is the default view.",
            ],
          },
        };
      }
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
      const filed: HeadlessPaneRow[] = buildInsiderRows(filtered, parsed).map((row, index) => {
        const entry = filtered[index]!;
        const last = filtered[index + 1]?.filing.accessionNumber !== entry.filing.accessionNumber;
        return isAmendedInsiderFiling(entry) && last ? { ...row, note: amendmentNote(entry) || null } : row;
      });
      // Every value says its currency; a base currency other than USD gets each value converted beside it.
      const based = await withInsiderBaseValues(filed, ctx.config.baseCurrency, dependencies.fxHistory ?? ctx.apiClient);
      const rows = based.rows;
      return {
        ...(based.columns ? { columns: withMoneyColumns(based.columns) } : {}),
        ...(based.note ? { notes: [based.note] } : {}),
        rows,
        // Nothing at all: the company has no Form 4 of its own, which is the whole answer.
        ...(empty ? { empty, unavailableSymbols: [] } : {}),
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
          limitations: ["Loaded Form 4 and Form 4/A rows are as filed, not reconciled transactions; affected aggregates are withheld."],
        },
      };
    },
  };
}

export const insiderHeadless = createInsiderHeadless();
