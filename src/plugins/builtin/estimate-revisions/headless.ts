import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { explainRefusal } from "../shared/cloud-denied";
import { DATE_OPTION_EXAMPLES } from "../../../utils/calendar-date";
import { fetchEstimates } from "./client";
import { estimateRevisionsLockNote } from "./lock-note";
import { estimateCurrent, estimateDifference, estimateSurprise, periodLabel, pinnedEstimatePeriods } from "./model";
import type { EstimateSurprise } from "../../../api-client/estimate-revisions";
import { isNotMeaningful } from "../../../utils/growth";

/**
 * A report as the Surprises tab reads it: `percent` is the surprise the pane
 * shows, the actual over the estimate (the source's own only when either is
 * missing), and null with `percentNotMeaningful` against a loss or zero estimate;
 * `difference` is its VS EST, the actual less the estimate.
 */
function surpriseRow(row: EstimateSurprise) {
  const surprise = estimateSurprise(row);
  const difference = estimateDifference(row);
  return {
    ...row,
    // Worked out from two cent figures, without the float's noise (2.10 - 1.98).
    difference: difference == null ? null : Number(difference.toFixed(4)),
    percent: typeof surprise === "number" ? Number((surprise * 100).toFixed(2)) : null,
    ...(isNotMeaningful(surprise) ? { percentNotMeaningful: true } : {}),
  };
}

export const estimateRevisionsHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  freshness: { status: "not-a-feed", basis: "analyst estimates" },
  argument: {
    kind: "ticker",
    placeholder: "ticker",
    description: "Listing ticker.",
  },
  options: [
    {
      key: "period",
      type: "string",
      description: `Optional fiscal end date, as ${DATE_OPTION_EXAMPLES}.`,
      settingKey: "period",
    },
    {
      key: "frequency",
      type: "enum",
      description: "Forecast frequency for a pinned fiscal period.",
      values: [{ value: "quarterly" }, { value: "annual" }],
      defaultValue: "quarterly",
      settingKey: "frequency",
    },
  ],
  discovery: {
    aliases: ["EM", "GUID", "EEO"],
    dataRequirements: ["Verified Gloom sign-in", "Gloom Cloud analyst snapshots"],
    limitations: [
      "Actual collection days and provider backfills remain separate.",
      "Range dispersion is not standard deviation.",
      "Guidance has no inferred numeric comparison.",
    ],
  },
  describe: (args) => `Estimate revisions ${args.symbols[0] ?? ""}`,
  async load(args, ctx) {
    const symbol = args.symbols[0]!,
      instrument = await ctx.resolveInstrument?.(symbol);
    const data = await fetchEstimates(
      instrument?.symbol ?? symbol,
      instrument?.exchange ?? "",
      ctx.apiClient,
      ctx.marketData,
    ).catch(async (error: unknown) => {
      throw await explainRefusal(error, estimateRevisionsLockNote, {
        symbol: args.symbols[0] ?? null,
        token: ctx.settings?.tab === "guidance" ? "GUID" : "EM",
        context: ctx,
      });
    });
    const periods = pinnedEstimatePeriods(
      data.periods,
      args.options.period,
      args.options.frequency,
      "--period",
    );
    return {
      sections: [
        {
          title: "Consensus",
          rows: periods.map((period) => ({
            period: periodLabel(period),
            currency: period.currency,
            asOf: estimateCurrent(period)?.date ?? null,
            eps: estimateCurrent(period)?.average ?? null,
            changePercent: period.change.percent,
            percentile: period.percentile.percentile,
            samples: period.percentile.samples,
          })),
        },
        {
          title: "Revision history",
          rows: periods.flatMap((period) =>
            [...period.recorded, ...period.lookbacks].map((row) => ({
              period: period.id,
              ...row,
            })),
          ),
        },
        {
          title: "Revision breadth",
          rows: periods.flatMap((period) =>
            period.breadth.map((row) => ({ period: period.id, ...row })),
          ),
        },
        { title: "Surprises", rows: data.surprises.map(surpriseRow) },
        {
          title: "Guidance",
          rows: data.guidance ? [{ ...data.guidance }] : [],
        },
      ],
      errors: data.gaps,
      metadata: {
        symbol: data.symbol,
        exchange: data.exchange,
        generatedAt: data.generatedAt,
        status: data.status,
        sources: data.sources,
        historyCoverage: data.historyCoverage,
      },
    };
  },
};
