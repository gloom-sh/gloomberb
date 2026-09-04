import type {
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import {
  curveAsOf,
  isInverted,
  loadYieldCurve,
  parseYieldPoints,
  spreadBasisPoints,
  type YieldCurveLoader,
  type YieldPoint,
} from "./treasury-data";

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
    argument: { kind: "none" },
    options: [],
    columns: COLUMNS,
    describe: "US Treasury Yield Curve",
    async load(args, ctx) {
      const points = await dependencies.load(
        args,
        () => ctx.apiClient.getCloudYieldCurve(),
      );
      const rows = parseYieldPoints(points);
      return {
        rows: rows.map((point) => ({ ...point })),
        metadata: {
          asOf: curveAsOf(points),
          inverted: isInverted(points),
          spread2Y10YBasisPoints: spreadBasisPoints(points),
        },
      };
    },
  };
}

export const yieldCurveHeadless = createYieldCurveHeadless();
