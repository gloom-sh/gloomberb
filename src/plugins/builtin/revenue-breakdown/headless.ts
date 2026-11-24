import type { RevenueBreakdownView } from "../../../api-client/revenue-breakdown";
import type { HeadlessPaneColumn, HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchRevenueBreakdown } from "./client";
import { filingPageUrl, growthPercent, reportedPeriods, reportedSpan, revenuePeriodLabeler, revenueScale, sharePercent } from "./model";
import { SEC_FILINGS } from "../shared/report-freshness";
import { resolveHeadlessIssuerListing } from "../shared/headless-market-data";

/** Shares and growth in percent, as the pane prints them (83.7%, +10.8%), amounts on the table's scale; exports keep the whole number. */
const number = (format: (value: number | null) => string) => (value: unknown) => format(typeof value === "number" ? value : null);

/**
 * A table's amounts on its one scale (`revenueScale`), named once in the text
 * report's heading ("Total revenue, USD millions"). Exports keep the section
 * name and the whole number.
 */
function amountScale(values: ReadonlyArray<number | null>, currency: string | null) {
  const scale = revenueScale(values, currency);
  return {
    section: (title: string) => ({ title, ...scale.unit ? { textTitle: `${title}, ${scale.unit}` } : {} }),
    column: (key: string, header: string): HeadlessPaneColumn => ({ key, header, align: "right", textFormat: number(scale.format) }),
  };
}

export const revenueBreakdownHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  freshness: { status: "not-a-feed", source: "Company filings", basis: "filed data", oldest: null },
  argument: {
    kind: "ticker",
    description: "Company ticker, with its exchange when needed.",
    placeholder: "ticker",
  },
  discovery: {
    aliases: ["SEG"],
    dataRequirements: ["Revenue breakdowns from company filings"],
    limitations: [
      "Rows are the members that add up to reported revenue; subtotals are dropped.",
      "Hong Kong filings give annual and interim periods, including for matching A shares. Korean filings give reported three-month periods. US filings give fiscal quarters.",
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
    const source = await fetchRevenueBreakdown(
      symbol,
      (args.options.view as RevenueBreakdownView | undefined) ?? "product",
      ctx.apiClient,
      await resolveHeadlessIssuerListing(ctx, symbol),
    );
    const data = reportedSpan(source);
    const periodLabel = revenuePeriodLabeler(source.periods);
    const labels = data.periods.map(periodLabel);
    const rowScale = amountScale(data.rows.flatMap((row) => [...row.values, row.ttm]), data.currency);
    const totalScale = amountScale(data.total, data.currency);
    const periods = reportedPeriods(data);
    const asReported = periods.length > 0;
    return {
      complete: data.access === "full",
      freshness: asReported ? { asOf: periods.at(-1)!.end } : { ...SEC_FILINGS, basis: "10-Q and 10-K filings" },
      errors: data.lockedRows > 0 ? [`${data.lockedRows} more rows need Gloom Pro`] : [],
      sections: [
        {
          ...rowScale.section(`${asReported ? "Reported" : "Quarterly"} revenue by ${data.view}`),
          columns: [
            { key: data.view, header: data.view[0]!.toUpperCase() + data.view.slice(1) },
            ...labels.map((label) => rowScale.column(label, label)),
            ...(!asReported ? [rowScale.column("ttm", "TTM")] : []),
            { key: "share", header: "Share", align: "right", textFormat: number(sharePercent) },
            ...(!asReported ? [{ key: "yoy", header: "YoY", align: "right" as const, textFormat: number(growthPercent) }] : []),
          ],
          rows: data.rows.map((row) => ({
            [data.view]: row.label,
            ...Object.fromEntries(labels.map((label, index) => [label, row.values[index]])),
            ...(!asReported ? { ttm: row.ttm } : {}),
            share: row.share,
            ...(!asReported ? { yoy: row.yoy } : {}),
          })),
        },
        {
          ...totalScale.section("Total revenue"),
          columns: asReported
            ? [{ key: "period", header: "Period" }, totalScale.column("revenue", "Revenue"), { key: "basis", header: "Basis" }, { key: "filed", header: "Filed" }, { key: "filing", header: "Filing" }]
            : [{ key: "quarter", header: "Quarter" }, { key: "end", header: "End" }, totalScale.column("revenue", "Revenue")],
          rows: data.periods.map((period, index) => "kind" in period
            ? { period: period.label, revenue: data.total[index], basis: period.revenueLabel, filed: period.filing.filed, filing: filingPageUrl(period.filing) }
            : { quarter: periodLabel(period), end: period.end, revenue: data.total[index] }),
        },
      ],
      metadata: {
        symbol: data.symbol,
        ...(data.cik ? { cik: data.cik } : {}),
        currency: data.currency,
        filed: data.filed,
        views: data.views,
      },
    };
  },
};
