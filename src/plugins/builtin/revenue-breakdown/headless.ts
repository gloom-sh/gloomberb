import type { RevenueBreakdownView } from "../../../api-client/revenue-breakdown";
import type { HeadlessPaneColumn, HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchRevenueBreakdown } from "./client";
import { growthPercent, quarterLabel, reportedSpan, revenueScale, sharePercent } from "./model";
import { SEC_FILINGS } from "../shared/report-freshness";
import { resolveHeadlessIssuerListing } from "../shared/headless-market-data";

/** Shares and growth in percent, as the pane prints them (83.7%, +10.8%), amounts on the table's scale; exports keep the whole number. */
const number = (format: (value: number | null) => string) => (value: unknown) => format(typeof value === "number" ? value : null);

/** A table's amounts on its one scale (`revenueScale`), named once in its title: "Total revenue, USD millions". */
function amountScale(values: ReadonlyArray<number | null>, currency: string | null) {
  const scale = revenueScale(values, currency);
  return {
    title: (title: string) => scale.unit ? `${title}, ${scale.unit}` : title,
    column: (key: string, header: string): HeadlessPaneColumn => ({ key, header, align: "right", textFormat: number(scale.format) }),
  };
}

export const revenueBreakdownHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  freshness: { ...SEC_FILINGS, basis: "10-Q and 10-K filings" },
  argument: {
    kind: "ticker",
    description: "SEC reporting issuer ticker.",
    placeholder: "ticker",
  },
  discovery: {
    aliases: ["SEG"],
    dataRequirements: ["Gloom Cloud revenue breakdowns from 10-Q and 10-K XBRL"],
    limitations: [
      "US filers only; 20-F filers report no quarterly breakdown.",
      "Rows are the members that add up to reported revenue; subtotals are dropped.",
      "Fiscal quarters; Q4 is the fiscal year less nine months.",
      "Free accounts get the two largest rows.",
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
    const symbol = args.symbols[0]!;
    const data = reportedSpan(await fetchRevenueBreakdown(
      symbol,
      (args.options.view as RevenueBreakdownView | undefined) ?? "product",
      ctx.apiClient,
      await resolveHeadlessIssuerListing(ctx, symbol),
    ));
    const rowScale = amountScale(data.rows.flatMap((row) => [...row.values, row.ttm]), data.currency);
    const totalScale = amountScale(data.total, data.currency);
    return {
      complete: data.access === "full",
      errors: data.lockedRows > 0 ? [`${data.lockedRows} more rows need Gloom Pro`] : [],
      sections: [
        {
          title: rowScale.title(`Quarterly revenue by ${data.view}`),
          columns: [
            { key: data.view, header: data.view[0]!.toUpperCase() + data.view.slice(1) },
            ...data.periods.map((period) => rowScale.column(quarterLabel(period), quarterLabel(period))),
            rowScale.column("ttm", "TTM"),
            { key: "share", header: "Share", align: "right", textFormat: number(sharePercent) },
            { key: "yoy", header: "YoY", align: "right", textFormat: number(growthPercent) },
          ],
          rows: data.rows.map((row) => ({
            [data.view]: row.label,
            ...Object.fromEntries(data.periods.map((period, index) => [quarterLabel(period), row.values[index]])),
            ttm: row.ttm,
            share: row.share,
            yoy: row.yoy,
          })),
        },
        {
          title: totalScale.title("Total revenue"),
          columns: [{ key: "quarter", header: "Quarter" }, { key: "end", header: "End" }, totalScale.column("revenue", "Revenue")],
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
