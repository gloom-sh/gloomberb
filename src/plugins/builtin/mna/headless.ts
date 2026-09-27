import type { MnaDealsParams, MnaRegionFilter, MnaStatusFilter, MnaTargetFilter } from "../../../api-client/mna";
import type { HeadlessPaneColumn, HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchMnaDeals } from "./client";
import { formatDealValue, formatExpectedClose, stageLabel, termsLabel } from "./model";

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
  argument: {
    kind: "ticker",
    optional: true,
    description: "Optional ticker: deals where it is the target or the buyer.",
  },
  discovery: {
    aliases: ["MA"],
    dataRequirements: ["Gloom Cloud M&A deals read from news stories, press releases and SEC filings"],
    limitations: [
      "Free accounts see deals 7 days after they were first reported",
      "Spreads need live quotes and are drawn by the pane, not listed here",
      "A private or non-US deal completes only when a story reports it",
    ],
  },
  options: [
    { key: "status", description: "Deal status.", type: "enum", defaultValue: "pending", values: ["pending", "talks", "completed", "terminated", "all"].map((value) => ({ value })) },
    { key: "target", description: "Public or private targets.", type: "enum", defaultValue: "all", values: ["all", "public", "private"].map((value) => ({ value })) },
    { key: "region", description: "US or international targets.", type: "enum", defaultValue: "all", values: ["all", "us", "intl"].map((value) => ({ value })) },
    { key: "query", description: "Company name or ticker.", type: "string" },
    { key: "limit", aliases: ["count", "rows"], description: "Maximum rows.", type: "integer", defaultValue: 50, minimum: 1, maximum: 100 },
  ],
  describe: (args) => `M&A${args.symbols[0] ? ` | ${args.symbols[0]}` : ""} | ${text(args.options.status) || "pending"}`,
  async load(args, ctx) {
    const symbol = args.symbols[0];
    const params: MnaDealsParams = {
      status: ((args.options.status as MnaStatusFilter | undefined) ?? (symbol ? "all" : "pending")),
      target: symbol ? undefined : (args.options.target as MnaTargetFilter | undefined),
      region: symbol ? undefined : (args.options.region as MnaRegionFilter | undefined),
      symbol,
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
        currency: deal.terms.currency,
        value: formatDealValue(deal.value, deal.valueCurrency),
        valueUsd: deal.valueUsd,
        expectedClose: deal.expectedClose,
        closed: deal.closed,
        headline: deal.headline,
      })),
      errors: payload.lockedDeals > 0 ? [`${payload.lockedDeals} deals from the last ${payload.delayDays} days need Gloom Pro`] : [],
      metadata: { asOf: payload.asOf, access: payload.access, delayDays: payload.delayDays, hasMore: payload.hasMore },
    };
  },
};
