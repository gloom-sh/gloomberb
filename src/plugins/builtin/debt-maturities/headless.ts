import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchDebtMaturities } from "./client";
import { bucketShare, debtAmount, debtNewestAsOf, debtNewestForm, debtNotices, debtPercent, newerQuarter } from "./model";
import { SEC_FILINGS } from "../shared/report-freshness";
import { resolveHeadlessIssuerListing } from "../shared/headless-market-data";

/** Amounts and shares as the pane prints them (952.00M, 12.5%); exports keep the whole number. */
const amount = (value: unknown) => debtAmount(typeof value === "number" ? value : null);
const percent = (value: unknown) => debtPercent(typeof value === "number" ? value : null);

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
      "Six relative fiscal maturity buckets; thereafter is open ended.",
      "Reported principal obligations, not carrying debt; scope can include short-term borrowing and hedges.",
      "Native currency; unsupported or missing facts remain null.",
      "No inferred weighted coupon or duration.",
      "Ten-year percentiles require five comparable annual observations.",
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
    const quarter = newerQuarter(data);
    return {
      complete: data.status === "available",
      errors: debtNotices(data),
      sections: [
        {
          title: "Principal maturity schedule",
          columns: [
            { key: "label", header: "Maturity" },
            { key: "value", header: "Principal", align: "right", textFormat: amount },
            { key: "currency", header: "Currency" },
            { key: "share", header: "% total", align: "right", textFormat: percent },
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
        // A 10-Q filed after the schedule: the balance-sheet debt it reports since.
        ...(quarter ? [{
          title: "Latest 10-Q",
          columns: [
            { key: "asOf", header: "As of" },
            { key: "form", header: "Form" },
            { key: "current", header: "Current debt", align: "right" as const, textFormat: amount },
            { key: "noncurrent", header: "Non-current debt", align: "right" as const, textFormat: amount },
            { key: "currency", header: "Currency" },
            { key: "filed", header: "Filed" },
          ],
          rows: [{
            asOf: quarter.asOf,
            form: quarter.form,
            current: quarter.current?.value ?? null,
            noncurrent: quarter.noncurrent?.value ?? null,
            currency: quarter.currency,
            filed: quarter.filed,
            currentConcept: quarter.current?.tag ?? null,
            noncurrentConcept: quarter.noncurrent?.tag ?? null,
            accession: quarter.accession,
          }],
        }] : []),
        {
          title: "Annual filing history",
          columns: [
            { key: "asOf", header: "As of" },
            { key: "totalPrincipal", header: "Principal", align: "right", textFormat: amount },
            { key: "next12MonthsShare", header: "Next 12m %", align: "right", textFormat: percent },
            { key: "next3YearsShare", header: "Next 3y %", align: "right", textFormat: percent },
            {
              key: "interestExpense",
              header: "Interest expense",
              align: "right",
              textFormat: amount,
            },
            {
              key: "borrowingCostPercent",
              header: "Cost proxy %",
              align: "right",
              textFormat: percent,
            },
            { key: "currency", header: "Currency" },
            { key: "filed", header: "Filed" },
          ],
          rows: data.history.toReversed().map((point) => ({ ...point })),
        },
      ],
      metadata: { ...data },
      // The latest filing dates the report (a newer 10-Q's balance date), named by its form so the date is
      // not read as the schedule's; the history rows are past years, not stale data.
      freshness: { asOf: debtNewestAsOf(data), asOfLabel: debtNewestForm(data) ?? undefined },
    };
  },
};
