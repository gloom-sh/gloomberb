import type { HeadlessPaneDefinition, HeadlessPaneFreshness } from "../../../types/plugin";
import { newestReportTime, oldestReportTime } from "../../../utils/utc-time";
import { fetchFuturesCurve, loadFuturesCurveAsOf } from "./client";
import { curveAsOfDate, normalizeCurveRoot, unsupportedCurveRootMessage } from "./model";

/** The root a report shows when none is given. */
const DEFAULT_ROOT = "ES";
const EXAMPLE_ROOT = "CL";

/** Percentiles read as the pane shows them, a whole rank. */
const rank = (value: number | null) => value == null ? null : Math.round(value);

export const futuresCurveHeadless: HeadlessPaneDefinition<"bundle"> = {
  discovery: { aliases: ["CTM"], dataRequirements: ["Gloom Cloud futures curve endpoint"],
    limitations: ["Listed-contract catalogues can be incomplete", "Ghosts and percentiles use the same listed contracts", "Cboe VIX is daily settlement"] },
  shape: "bundle", argument: { kind: "free-text", optional: true, placeholder: "root", description: "FUT root such as CL, ES, ZN or VX, or a CME crypto root (BTC, ETH, SOL, XRP). Defaults to ES." },
  // Only the pane reads the tab; the report always carries both.
  options: [{ key: "tab", description: "Curve or the full contract table.", type: "enum",
    values: [{ value: "curve" }, { value: "contracts", aliases: ["contract", "table"] }], defaultValue: "curve",
    pluginState: { pluginId: "market-overview", key: "tab" } },
  { key: "date", type: "string", settingKey: "asOfDate", description: "Past date (YYYY-MM-DD): the curve as the daily settlement archive held it, with the curves a week and a month before." }],
  describe: (args) => `Futures curve ${args.argument || DEFAULT_ROOT}`,
  async load(args, ctx) {
    const input = args.argument || DEFAULT_ROOT;
    const root = normalizeCurveRoot(input);
    if (!root) throw new Error(unsupportedCurveRootMessage(input));
    const date = curveAsOfDate(args.options.date);
    const data = date ? await loadFuturesCurveAsOf(root, date, ctx.apiClient) : await fetchFuturesCurve(root, ctx.apiClient);
    // Dated by the contracts' own quotes; the same-contract history rows are a year of context, not observations.
    const quoted = data.contracts.map((row) => row.asOf);
    const freshness: HeadlessPaneFreshness = date
      ? { status: "not-a-feed", basis: "settlement archive", asOf: date }
      : { ...(data.source === "cboe" ? { source: "Cboe", status: "not-a-feed", basis: "daily settlement", cadence: "daily" } as const : {}),
        asOf: newestReportTime(quoted), oldest: oldestReportTime(quoted) };
    return {
      freshness,
      sections: [
        { title: "Contracts", rows: data.contracts.map((row) => ({ ...row, percentile: rank(row.percentile) })) },
        { title: "Front spread", rows: [{ ...data.slope, annualizedRollYield: data.slope.annualizedRollYield == null ? null : Number(data.slope.annualizedRollYield.toFixed(2)),
          percentile: rank(data.slope.percentile), rollPercentile: rank(data.slope.rollPercentile) }] },
        ...data.ghosts.map((ghost) => ({ title: `${ghost.label} same-contract history`, rows: ghost.points.map((point) => ({ ...point })) })),
      ],
      errors: data.gaps,
      metadata: { ...data, ...(args.argument ? {} : { defaultArgument: DEFAULT_ROOT, notices: [`Showing ${DEFAULT_ROOT}. Try fn CTM ${EXAMPLE_ROOT}.`] }),
        complete: data.status === "available", percentileBasis: "Same-contract observations within one year; actual sample start/end retained" },
    };
  },
};
