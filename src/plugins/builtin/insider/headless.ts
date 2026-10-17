import type {
  HeadlessPaneColumn,
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
  HeadlessPaneRow,
} from "../../../types/plugin";
import { formatCompact, formatCurrency } from "../../../utils/format";
import { loadParsedInsiderFilings, type InsiderFilingsLoad } from "./client";
import { insiderEmptyNotice } from "./issuer";
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
import { resolveHeadlessIssuerListing } from "../shared/headless-market-data";
import { noSecReportsNotice } from "../../../utils/sec";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import type { InsiderSignalRoleGroup, InsiderSignalSide, InsiderSignalsPayload } from "../../../api-client/insider-signals";
import { DEFAULT_INSIDER_SIGNALS_QUERY, loadInsiderSignals, type InsiderSignalsQuery } from "./signals-client";
import {
  formatInsiderStakeChange,
  formatSignalDay,
  formatSignalValue,
  INSIDER_SIGNAL_CAP_OPTIONS,
  INSIDER_SIGNALS_TITLE,
  insiderSideWords,
  insiderSignalsEmptyTitle,
  insiderSignalsFiltered,
  insiderSignalWhy,
} from "./signals-model";

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

/**
 * The ranking without a ticker: the pane's columns in the side's words, why
 * as the chips' facts in text, then each row's insiders under it with what
 * their holding did.
 */
function signalColumns(side: InsiderSignalSide): HeadlessPaneColumn[] {
  const words = insiderSideWords(side);
  return [
    { key: "ticker", header: "Ticker" },
    // Why is the point: the company gives way first, and on a narrow table moves under the row before why is cut.
    { key: "company", header: "Company", stackPriority: 2 },
    { key: "score", header: "Score", align: "right" },
    { key: "why", header: "Why", minWidth: 46 },
    { key: "insiders", header: words.insiders, align: "right" },
    { key: "value", header: words.traded, align: "right", format: (value) => typeof value === "number" ? formatSignalValue(value) : "-" },
    { key: "lastBuy", header: words.last, format: (value) => typeof value === "string" ? formatSignalDay(value) : "-" },
    { key: "filingDate", header: "Filed", stackPriority: 1, format: (value) => typeof value === "string" ? value : "-" },
    { key: "buyers", header: "Insiders", underRow: true, format: (value) => typeof value === "string" ? value : "" },
  ];
}

function signalRows(payload: InsiderSignalsPayload, side: InsiderSignalSide): HeadlessPaneRow[] {
  return payload.rows.map((row) => ({
    ticker: row.ticker,
    company: row.company,
    score: row.score,
    why: insiderSignalWhy(row, side),
    reasons: row.reasons,
    whySignals: row.whySignals ?? null,
    insiders: row.insiders,
    buys: row.buys,
    value: row.value,
    shares: row.shares,
    firstBuy: row.firstBuy,
    lastBuy: row.lastBuy,
    filingDate: row.lastFiled,
    marketCap: row.marketCap ?? null,
    buyers: row.buyers.map((buyer) => {
      const stake = formatInsiderStakeChange(buyer);
      return `${formatInsiderName(buyer.name)} (${buyer.role}) ${formatSignalValue(buyer.value)}${stake === "--" ? "" : ` ${stake}`}`;
    }).join("; "),
    signals: row.signals,
  }));
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
  loadSignals?(query: InsiderSignalsQuery, limit: number, ctx: HeadlessPaneContext): Promise<InsiderSignalsPayload>;
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
        pluginState: { pluginId: "ticker-research", key: "nameFilter" },
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
        aliases: ["count", "rows"],
        description: "Maximum of the company's own Form 4 and Form 4/A filings to parse; without a ticker, companies to rank.",
        type: "integer",
        defaultValue: 20,
        minimum: 1,
        maximum: 100,
      },
      {
        key: "window",
        aliases: ["days"],
        description: "Without a ticker: days of open-market buying or selling to rank, 1 to 90.",
        type: "integer",
        defaultValue: 30,
        minimum: 1,
        maximum: 90,
        pluginState: SIGNAL_OPTION_STATE("window"),
      },
      {
        key: "side",
        description: "Without a ticker: rank insider buying (open-market purchases) or selling (sales an insider chose: not under a Rule 10b5-1 plan, to cover tax, out of an option exercise or in an offering).",
        type: "enum",
        defaultValue: "buy",
        values: [
          { value: "buy", aliases: ["buys", "buying", "purchases"] },
          { value: "sell", aliases: ["sells", "selling", "sales"] },
        ],
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
        pluginState: SIGNAL_OPTION_STATE("position"),
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
    describe: (args) => args.symbols[0]
      ? `Insider Transactions | ${args.symbols[0]}`
      : `${INSIDER_SIGNALS_TITLE} | ${args.options.side === "sell" ? "Selling" : "Buying"}`,
    async load(args, ctx) {
      const symbol = args.symbols[0];
      if (!symbol) {
        const query = signalQuery(args.options);
        const payload = await (dependencies.loadSignals ?? defaultDependencies.loadSignals!)(query, Number(args.options.limit), ctx);
        const side = payload.side ?? "buy";
        return {
          columns: signalColumns(side),
          rows: signalRows(payload, side),
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
      const limit = Number(args.options.limit);
      const { parsed, foreignPrivateIssuer, noFilings } = await dependencies.loadParsed(symbol, limit, args, ctx);
      const empty = parsed.length > 0 ? null
        : (noFilings ? await noSecReportsEmpty(ctx, symbol) : null) ?? insiderEmptyNotice(foreignPrivateIssuer);
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
