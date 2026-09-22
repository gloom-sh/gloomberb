import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchEstimates } from "./client";
import { estimateCurrent, periodLabel, pinnedEstimatePeriods } from "./model";
export const estimateRevisionsHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  argument: {
    kind: "ticker",
    placeholder: "ticker",
    description: "Listing ticker.",
  },
  options: [
    {
      key: "period",
      type: "string",
      description: "Optional fiscal end date, YYYY-MM-DD.",
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
    dataRequirements: ["Gloom Cloud analyst snapshots"],
    limitations: [
      "Actual collection days and provider backfills remain separate",
      "Range dispersion is not standard deviation",
      "Guidance has no inferred numeric comparison",
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
    );
    const periods = pinnedEstimatePeriods(
      data.periods,
      args.options.period,
      args.options.frequency,
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
        { title: "Surprises", rows: data.surprises.map((row) => ({ ...row })) },
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
