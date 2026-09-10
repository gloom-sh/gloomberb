import type {
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import {
  curveAsOf,
  isInverted,
  loadYieldCurve,
  spreadBasisPoints,
  type YieldCurveLoader,
  type YieldPoint,
} from "./treasury-data";
import { completeYieldCurve, loadHistoricalYieldCurve, yieldCurveDate } from "./history";

const COLUMNS = [
  { key: "maturity", header: "Maturity" },
  {
    key: "maturityYears",
    header: "Years",
    align: "right" as const,
    format: (value: unknown) => Number(value).toFixed(2).replace(/\.00$/, ""),
  },
  {
    key: "yield",
    header: "Yield",
    align: "right" as const,
    format: (value: unknown) => value == null ? "-" : `${Number(value).toFixed(2)}%`,
  },
  { key: "asOf", header: "As of" },
];

export interface YieldCurveHeadlessDependencies {
  load(args: HeadlessPaneLoadArgs, loader: YieldCurveLoader): Promise<YieldPoint[]>;
}

const defaultDependencies: YieldCurveHeadlessDependencies = {
  load: (_args, loader) => loadYieldCurve(loader),
};

export function createYieldCurveHeadless(
  dependencies: YieldCurveHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    argument: { kind: "free-text", optional: true, placeholder: "YYYY-MM-DD", description: "Historical as-of date; omit for latest." },
    options: [{ key: "date", type: "string", description: "Historical as-of date (YYYY-MM-DD); uses the latest observation on or before it." }],
    columns: COLUMNS,
    describe: "US Treasury Yield Curve",
    async load(args, ctx) {
      const requestedDate = yieldCurveDate(args.options.date ?? args.argument);
      const points = completeYieldCurve(await dependencies.load(
        args,
        requestedDate
          ? () => loadHistoricalYieldCurve(requestedDate, (id, options) => ctx.apiClient.getCloudFredSeries(id, options))
          : () => ctx.apiClient.getCloudYieldCurve(),
      ));
      const rows = [...points].sort((a, b) => a.maturityYears - b.maturityYears);
      const missingTenors = points.filter((point) => point.yield == null).map((point) => point.maturity);
      return {
        rows: rows.map((point) => ({ ...point })),
        errors: [
          ...(missingTenors.length ? [`Treasury tenors unavailable: ${missingTenors.join(", ")}`] : []),
          ...(!curveAsOf(points) ? ["Curve has mixed or unknown observation dates."] : []),
          ...(points.some((point) => point.stale) ? ["Some Treasury sources are stale cached data."] : []),
        ],
        metadata: {
          source: "FRED / US Treasury constant maturity rates",
          units: "Percent",
          requestedDate: requestedDate || null,
          asOf: curveAsOf(points),
          inverted: isInverted(points),
          spread2Y10YBasisPoints: spreadBasisPoints(points),
          missingTenors,
          stale: points.some((point) => point.stale),
        },
      };
    },
  };
}

export const yieldCurveHeadless = createYieldCurveHeadless();
