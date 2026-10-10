import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchDebtMaturities } from "./client";
import { bucketShare, debtNotices } from "./model";
import { SEC_FILINGS } from "../shared/report-freshness";
import { resolveHeadlessIssuerListing } from "../shared/headless-market-data";

export const debtMaturitiesHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  freshness: SEC_FILINGS,
  argument: {
    kind: "ticker",
    description: "SEC reporting issuer ticker.",
    placeholder: "ticker",
  },
  discovery: {
    aliases: ["DDIS"],
    dataRequirements: ["Gloom Cloud SEC principal maturity schedules"],
    limitations: [
      "Six relative fiscal maturity buckets; thereafter is open ended",
      "Reported principal obligations, not carrying debt; scope can include short-term borrowing and hedges",
      "Native currency; unsupported or missing facts remain null",
      "No inferred weighted coupon or duration",
      "Ten-year percentiles require five comparable annual observations",
    ],
  },
  options: [
    {
      key: "tab",
      type: "enum",
      settingKey: "tab",
      description: "Initial debt view.",
      defaultValue: "maturities",
      values: [
        { value: "maturities" },
        { value: "history" },
        { value: "filing" },
      ],
    },
  ],
  describe: (args) => `Debt maturities | ${args.symbols[0]}`,
  async load(args, ctx) {
    const symbol = args.symbols[0]!;
    const data = await fetchDebtMaturities(symbol, ctx.apiClient, await resolveHeadlessIssuerListing(ctx, symbol));
    return {
      complete: data.status === "available",
      errors: debtNotices(data),
      sections: [
        {
          title: "Principal maturity schedule",
          columns: [
            { key: "label", header: "Maturity" },
            { key: "value", header: "Principal", align: "right" },
            { key: "currency", header: "Currency" },
            { key: "share", header: "% total", align: "right" },
            { key: "asOf", header: "As of" },
            { key: "filed", header: "Filed" },
          ],
          rows:
            data.latest?.buckets.map((row) => ({
              ...row,
              currency: data.latest!.currency,
              share: bucketShare(row, data.latest!),
              asOf: data.latest!.asOf,
              filed: data.latest!.filed,
            })) ?? [],
        },
        {
          title: "Annual filing history",
          columns: [
            { key: "asOf", header: "As of" },
            { key: "totalPrincipal", header: "Principal", align: "right" },
            { key: "next12MonthsShare", header: "Next 12m %", align: "right" },
            { key: "next3YearsShare", header: "Next 3y %", align: "right" },
            {
              key: "interestExpense",
              header: "Interest expense",
              align: "right",
            },
            {
              key: "borrowingCostPercent",
              header: "Cost proxy %",
              align: "right",
            },
            { key: "currency", header: "Currency" },
            { key: "filed", header: "Filed" },
          ],
          rows: data.history.toReversed().map((point) => ({ ...point })),
        },
      ],
      metadata: { ...data },
      // The latest filing dates the report; the history rows are past years, not stale data.
      freshness: { asOf: data.latest?.asOf ?? null },
    };
  },
};
