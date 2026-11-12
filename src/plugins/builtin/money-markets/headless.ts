import type { HeadlessPaneDefinition } from "../../../types/plugin";
import type { MoneyMarketRow } from "../../../api-client/money-markets";
import { fetchHongKongMoneyMarkets, fetchMoneyMarkets } from "./client";
import { isHongKongTab, MONEY_MARKET_TABS, moneyMarketChange, moneyMarketNotices, moneyMarketRowNotices, moneyMarketRows, moneyMarketValue } from "./model";

const FRED_FRESHNESS = { source: "FRED", status: "not-a-feed", basis: "published daily and weekly data" } as const;
const HONG_KONG_FRESHNESS = { ...FRED_FRESHNESS, source: "HKMA", basis: "published Exchange Fund Bill closing yields" } as const;

/** The rows a view reports, without their histories, and what the view declares about them beyond the definition. */
export function moneyMarketReport(rows: readonly MoneyMarketRow[], hongKong: boolean) {
  return {
    ...hongKong ? { freshness: HONG_KONG_FRESHNESS } : {},
    rows: rows.map(({ history: _history, ...row }) => ({ ...row, percentileValue: row.percentile.value })),
  };
}

export const moneyMarketsHeadless: HeadlessPaneDefinition<"bundle"> = {
  discovery: { aliases: ["BTMM"], dataRequirements: ["Gloom Cloud money-markets endpoint"],
    limitations: ["Published daily and weekly observations.", "Treasury bill discount yields.", "Net liquidity is a same-date proxy.",
      "Hong Kong: HKMA's Exchange Fund Bill closing yields, a week or two after the day; each row is dated by its own day. HIBOR is not licensed for redistribution."] },
  shape: "bundle", argument: { kind: "none" },
  freshness: FRED_FRESHNESS,
  options: [{ key: "tab", type: "enum", description: "Money-market view: US rates, bills or liquidity, or Hong Kong's Exchange Fund Bill yields.",
    values: MONEY_MARKET_TABS.map(({ value }) => ({ value })), defaultValue: "rates" }],
  describe: (args) => isHongKongTab(args.options.tab) ? "Hong Kong money markets" : "US money markets",
  async load(args, ctx) {
    const hongKong = isHongKongTab(args.options.tab);
    const data = hongKong ? await fetchHongKongMoneyMarkets(ctx.apiClient) : await fetchMoneyMarkets(ctx.apiClient);
    const rows: MoneyMarketRow[] = "billsCurve" in data ? moneyMarketRows(data, String(args.options.tab)) : data.rows;
    const errors = "billsCurve" in data ? moneyMarketNotices(data) : moneyMarketRowNotices(data.rows);
    const complete = data.status === "available" && errors.length === 0;
    const report = moneyMarketReport(rows, hongKong);
    return { complete, ...report.freshness ? { freshness: report.freshness } : {},
      sections: [{ title: hongKong ? "Exchange Fund Bill yields" : "Observations", columns: [
      { key: "label", header: "Instrument" },
      { key: "value", header: "Level", align: "right", format: (value, row) => moneyMarketValue(value as number | null, row.unit as "percent" | "usd-billions") },
      { key: "change", header: "Change", align: "right", format: (value, row) => moneyMarketChange(value as number | null, row.changeUnit as "basis-points" | "usd-billions") },
      // A narrow terminal moves the status, percentile and earlier date under each row first.
      { key: "previousAsOf", header: "Versus", shrink: false, stackPriority: 1 },
      { key: "percentileValue", header: "Pctl 1Y", align: "right", stackPriority: 2, format: (value) => value == null ? "--" : Number(value).toFixed(0) },
      { key: "asOf", header: "As of", shrink: false }, { key: "status", header: "Status", stackPriority: 3 },
    ], rows: report.rows }],
      errors, unavailableSymbols: rows.filter((row) => row.status === "unavailable").flatMap((row) => row.sourceSeriesIds.length ? row.sourceSeriesIds : [row.label]),
      metadata: { ...data, complete, selectedTab: args.options.tab } };
  },
};
