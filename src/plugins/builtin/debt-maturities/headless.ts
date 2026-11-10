import type { DebtMaturitiesPayload } from "../../../api-client/debt-maturities";
import type { HeadlessBundleSection } from "../../../types/headless";
import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchDebtMaturities } from "./client";
import {
  bandScaleText, bandTotal, bucketShare, debtAmount, debtBands, debtBasis, debtCostProxyNote, debtHistoryRows, debtNewestAsOf,
  debtNewestForm, debtNotices, debtPercent, debtStandard, maturityRows, newerQuarter, type DebtLatest,
} from "./model";
import { SEC_FILINGS } from "../shared/report-freshness";
import { resolveHeadlessIssuerListing } from "../shared/headless-market-data";

/** Amounts and shares as the pane prints them (952.00M, 12.5%); exports keep the whole number. */
const amount = (value: unknown) => debtAmount(typeof value === "number" ? value : null);
const percent = (value: unknown) => debtPercent(typeof value === "number" ? value : null);

/**
 * A schedule in its filing's own bands, as the pane shows it: each band as
 * reported with its share of their total, then the filing (standard, what the
 * amounts are, how the report states them, the report's link). Exports name
 * the basis on every row, so the amount column reads the same for every
 * company; the text report heads it with the basis.
 */
function bandSections(data: DebtMaturitiesPayload, latest: DebtLatest): HeadlessBundleSection[] {
  const basis = debtBasis(latest);
  const standard = debtStandard(latest.taxonomy);
  const columns = [
    { key: "label", header: "Maturity" },
    { key: "value", header: "Amount", align: "right" as const, textFormat: amount },
    { key: "currency", header: "Currency" },
    { key: "share", header: "% total", align: "right" as const, textFormat: percent },
    { key: "asOf", header: "As of" },
    { key: "filed", header: "Filed" },
  ];
  const source = latest.source;
  const check = source?.reconciledTo;
  const filing: Array<[string, string | null | undefined]> = [
    ["Standard", standard],
    ["Basis", basis.detail ? `${basis.words} (${basis.detail})` : basis.words],
    [basis.total, `${debtAmount(bandTotal(debtBands(latest)!))} ${latest.currency}`],
    ["Reported in", source ? bandScaleText(latest.currency, source.scale, source.scaleStated) : latest.currency],
    ["Form", latest.form],
    ["Accession", latest.accession],
    ["Table", source?.concept],
    ["Checked against", check ? `${check.concept} (${check.ratio.toFixed(2)}x)` : null],
    ["Lease liabilities", latest.includesLeases ? "Included" : null],
    ["Report", latest.filingUrl],
  ];
  return [
    {
      title: "Maturity schedule as reported",
      textTitle: `Maturity schedule as reported (${[basis.words, standard].filter(Boolean).join(", ")})`,
      columns: [
        ...columns.slice(0, 2),
        { key: "basis", header: "Basis" },
        { key: "fromMonths", header: "From month" },
        { key: "toMonths", header: "To month" },
        ...columns.slice(2),
        { key: "readFrom", header: "Read from" },
      ],
      textColumns: [columns[0]!, { ...columns[1]!, header: basis.amount }, ...columns.slice(2)],
      rows: maturityRows(latest).map((row) => ({
        label: row.label,
        value: row.value,
        basis: latest.amountBasis ?? "principal",
        fromMonths: row.band!.fromMonths,
        toMonths: row.band!.toMonths,
        currency: latest.currency,
        share: row.share,
        asOf: latest.asOf,
        filed: latest.filed,
        readFrom: row.band!.members.join(" + "),
      })),
    },
    {
      title: "Filing",
      columns: [{ key: "field", header: "Field" }, { key: "value", header: "Value" }],
      rows: filing.flatMap(([field, value]) => (value ? [{ field, value }] : [])),
    },
  ];
}

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
    const latest = data.latest;
    if (latest && debtBands(latest)) {
      return {
        complete: data.status === "available",
        errors: debtNotices(data),
        // What the schedule covers and how it was read, beside it: never a failure.
        ...(data.notes?.length ? { notes: data.notes } : {}),
        sections: bandSections(data, latest),
        metadata: { ...data },
        // Dated by the report's balance sheet: an SEC filing named by its form, a report outside SEC cited
        // as the server names it (its form, HKEX or CNINFO, would repeat that name).
        freshness: data.cik ? { asOf: latest.asOf, asOfLabel: latest.form } : { asOf: latest.asOf, source: data.source.name },
      };
    }
    const quarter = newerQuarter(data);
    const costNote = debtCostProxyNote(data.history);
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
            {
              // What the proxy divides: exports keep `filed` or `average-principal`, the text says it in words.
              key: "borrowingCostBasis",
              header: "Cost basis",
              optional: true,
              textFormat: (value) => value === "filed" ? "Filed" : value === "average-principal" ? "Avg principal" : "",
            },
            { key: "currency", header: "Currency" },
            { key: "filed", header: "Filed" },
          ],
          rows: debtHistoryRows(data.history).map((row) => ({ ...row })),
        },
      ],
      ...(costNote || data.notes?.length ? { notes: [...(data.notes ?? []), ...(costNote ? [costNote] : [])] } : {}),
      metadata: { ...data },
      // The latest filing dates the report (a newer 10-Q's balance date), named by its form so the date is
      // not read as the schedule's; the history rows are past years, not stale data.
      freshness: { asOf: debtNewestAsOf(data), asOfLabel: debtNewestForm(data) ?? undefined },
    };
  },
};
