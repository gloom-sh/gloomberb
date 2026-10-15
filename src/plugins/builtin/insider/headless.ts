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
import type { InsiderSignalsPayload } from "../../../api-client/insider-signals";
import { loadInsiderSignals } from "./signals-client";
import { formatSignalDay, formatSignalValue, insiderSignalsEmptyTitle, insiderSignalWhy } from "./signals-model";

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

/** The ranking without a ticker: the pane's columns, then each row's biggest buyers under it. */
const SIGNAL_COLUMNS: HeadlessPaneColumn[] = [
  { key: "ticker", header: "Ticker" },
  { key: "company", header: "Company" },
  { key: "score", header: "Score", align: "right" },
  { key: "why", header: "Why" },
  { key: "insiders", header: "Buyers", align: "right" },
  { key: "value", header: "Bought", align: "right", format: (value) => typeof value === "number" ? formatSignalValue(value) : "-" },
  { key: "lastBuy", header: "Last Buy", format: (value) => typeof value === "string" ? formatSignalDay(value) : "-" },
  { key: "filingDate", header: "Filed", format: (value) => typeof value === "string" ? value : "-" },
  { key: "buyers", header: "Top Buyers", underRow: true, format: (value) => typeof value === "string" ? value : "" },
];

function signalRows(payload: InsiderSignalsPayload): HeadlessPaneRow[] {
  return payload.rows.map((row) => ({
    ticker: row.ticker,
    company: row.company,
    score: row.score,
    why: insiderSignalWhy(row),
    reasons: row.reasons,
    insiders: row.insiders,
    buys: row.buys,
    value: row.value,
    shares: row.shares,
    firstBuy: row.firstBuy,
    lastBuy: row.lastBuy,
    filingDate: row.lastFiled,
    buyers: row.buyers.map((buyer) => `${formatInsiderName(buyer.name)} (${buyer.role}) ${formatSignalValue(buyer.value)}`).join("; "),
    signals: row.signals,
  }));
}

/** What a Form 4/A says about itself, for its last row in the report. */
function amendmentNote(entry: ParsedInsiderFiling): string {
  const original = entry.disclosure?.originalFilingDate;
  return [original ? `Original filed ${original}` : "", ...buildInsiderDisclosureText(entry).split("\n")].filter(Boolean).join("\n");
}

export interface InsiderHeadlessDependencies {
  loadSignals?(window: number, limit: number, ctx: HeadlessPaneContext): Promise<InsiderSignalsPayload>;
  loadParsed(
    symbol: string,
    limit: number,
    args: HeadlessPaneLoadArgs,
    ctx: HeadlessPaneContext,
  ): Promise<InsiderFilingsLoad>;
}

const defaultDependencies: InsiderHeadlessDependencies = {
  loadSignals: async (window, limit, ctx) => (await loadInsiderSignals(window, {
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
      description: "US equity ticker; omit for the companies whose insiders are buying in the open market.",
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
        description: "Without a ticker: days of open-market buying to rank, 1 to 90.",
        type: "integer",
        defaultValue: 30,
        minimum: 1,
        maximum: 90,
      },
    ],
    columns: INSIDER_COLUMNS,
    describe: (args) => args.symbols[0] ? `Insider Transactions | ${args.symbols[0]}` : "Insider Buying",
    async load(args, ctx) {
      const symbol = args.symbols[0];
      if (!symbol) {
        const window = Number(args.options.window) || 30;
        const payload = await (dependencies.loadSignals ?? defaultDependencies.loadSignals!)(window, Number(args.options.limit), ctx);
        return {
          columns: SIGNAL_COLUMNS,
          rows: signalRows(payload),
          ...(payload.rows.length === 0 ? { empty: insiderSignalsEmptyTitle(payload.window) } : {}),
          metadata: {
            window: payload.window,
            through: payload.through,
            asOf: payload.asOf,
            coverage: payload.coverage,
            limitations: [
              "Open-market purchases (Form 4 code P) by officers, directors and 10% owners only; forms a company files as an owner of another issuer are left out.",
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
