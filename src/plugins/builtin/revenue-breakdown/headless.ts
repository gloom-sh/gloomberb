import type { RevenueBreakdownView } from "../../../api-client/revenue-breakdown";
import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchRevenueBreakdown } from "./client";
import { quarterLabel, reportedSpan } from "./model";

export const revenueBreakdownHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  argument: {
    kind: "ticker",
    description: "SEC reporting issuer ticker.",
    placeholder: "ticker",
  },
  discovery: {
    aliases: ["SEG"],
    dataRequirements: ["Gloom Cloud revenue breakdowns from 10-Q and 10-K XBRL"],
    limitations: [
      "US filers only; 20-F filers report no quarterly breakdown",
      "Rows are the members that add up to reported revenue; subtotals are dropped",
      "Fiscal quarters; Q4 is the fiscal year less nine months",
      "Free accounts get the two largest rows",
    ],
  },
  options: [
    {
      key: "view",
      type: "enum",
      settingKey: "view",
      description: "Split revenue by product, segment or region.",
      defaultValue: "product",
      values: [{ value: "product" }, { value: "segment" }, { value: "region" }],
    },
  ],
  describe: (args) => `Revenue breakdown | ${args.symbols[0]}`,
  async load(args, ctx) {
    const data = reportedSpan(await fetchRevenueBreakdown(
      args.symbols[0]!,
      (args.options.view as RevenueBreakdownView | undefined) ?? "product",
      ctx.apiClient,
    ));
    return {
      complete: data.access === "full",
      errors: data.lockedRows > 0 ? [`${data.lockedRows} more rows need Gloom Pro`] : [],
      sections: [
        {
          title: `Quarterly revenue by ${data.view}`,
          rows: data.rows.map((row) => ({
            [data.view]: row.label,
            ...Object.fromEntries(data.periods.map((period, index) => [quarterLabel(period), row.values[index]])),
            ttm: row.ttm,
            share: row.share,
            yoy: row.yoy,
          })),
        },
        {
          title: "Total revenue",
          rows: data.periods.map((period, index) => ({
            quarter: quarterLabel(period),
            end: period.end,
            revenue: data.total[index],
          })),
        },
      ],
      metadata: {
        symbol: data.symbol,
        cik: data.cik,
        currency: data.currency,
        filed: data.filed,
        views: data.views,
      },
    };
  },
};
