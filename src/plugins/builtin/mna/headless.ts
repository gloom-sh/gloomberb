import type { MnaDealsParams, MnaRegionFilter, MnaStatusFilter, MnaTargetFilter } from "../../../api-client/mna";
import type { HeadlessPaneColumn, HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchMnaDeals } from "./client";
import { dealsSymbol, formatDealValue, formatExpectedClose, stageLabel, termsLabel } from "./model";
import { REPORT_ROWS } from "../shared/headless-options";

const text = (value: unknown) => (typeof value === "string" ? value : "");

const COLUMNS: HeadlessPaneColumn[] = [
  { key: "announced", header: "Announced" },
  { key: "target", header: "Target" },
  { key: "targetSymbol", header: "Symbol" },
  { key: "acquirer", header: "Acquirer" },
  { key: "terms", header: "Terms" },
  { key: "value", header: "Value", align: "right" },
  { key: "stage", header: "Stage" },
  { key: "expectedClose", header: "Close", format: (value) => formatExpectedClose(text(value) || null) },
  { key: "closed", header: "Closed" },
];

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
      "Spreads need live quotes and are drawn by the pane, not listed here.",
      "A private or non-US deal completes only when a story reports it.",
    ],
  },
  options: [
    { key: "status", description: "Deal status.", type: "enum", defaultValue: "pending", values: ["pending", "talks", "completed", "terminated", "all"].map((value) => ({ value })) },
    { key: "target", description: "Public or private targets.", type: "enum", defaultValue: "public", values: ["all", "public", "private"].map((value) => ({ value })) },
    { key: "region", description: "US or international targets.", type: "enum", defaultValue: "all", values: ["all", "us", "intl"].map((value) => ({ value })) },
    { key: "query", shot: { reportOnly: "searches the text report, and the pane opens without a search" }, description: "Company name or ticker.", type: "string" },
    { key: "limit", shot: REPORT_ROWS, aliases: ["count", "rows"], description: "Maximum rows.", type: "integer", defaultValue: 50, minimum: 1, maximum: 100 },
  ],
  describe: (args) => `M&A${args.symbols[0] ? ` | ${args.symbols[0]}` : ""} | ${text(args.options.status) || "pending"}`,
  // The filters the pane keeps, as asked for; one company's deals keep their status apart and have no target or region filter.
  shotState: (args, _load, given) => {
    const symbol = args.symbols[0];
    const unused = symbol ? ["target", "region"].filter((key) => given.has(key)) : [];
    if (unused.length) {
      throw new Error(`One company's deals have no ${unused.map((key) => `--${key}`).join(" or ")} filter. Drop it from shot, or leave out ${symbol} for the market's deals.`);
    }
    const prefix = symbol ? "ticker." : "";
    const state = Object.fromEntries(["status", "target", "region"].filter((key) => given.has(key)).map((key) => [`${prefix}${key}`, args.options[key]]));
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
    const payload = await fetchMnaDeals(params, ctx.apiClient);
    return {
      columns: COLUMNS,
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
        closed: deal.closed,
        headline: deal.headline,
      })),
      errors: payload.lockedDeals > 0 ? [`${payload.lockedDeals} deals from the last ${payload.delayDays} days need Gloom Pro`] : [],
      metadata: {
        asOf: payload.asOf, access: payload.access, delayDays: payload.delayDays, hasMore: payload.hasMore,
      },
    };
  },
};
