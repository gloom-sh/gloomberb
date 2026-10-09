import type {
  HeadlessPaneContext,
  HeadlessPaneDefinition,
} from "../../../types/plugin";
import {
  compareDate, CURVE_OPTIONS, curveIdOf, curveOption, curveSpreadFigures, loadComparePoints, loadCurveData, parseCompareInput,
  parseCurveArgument, type CurveData, type CurveId,
} from "./curves";
import { curveAsOf, type YieldPoint, yieldCurveErrors } from "./treasury-data";
import { yieldCurveDate } from "./history";
import { loadWorldRows, type WorldRow } from "./world";

const percent = (value: unknown) => value == null ? "-" : `${Number(value).toFixed(2)}%`;
const basisPoints = (value: unknown) => value == null ? "-" : `${Number(value) > 0 ? "+" : ""}${Math.round(Number(value))}bp`;
const COLUMNS = [
  { key: "maturity", header: "Maturity" },
  {
    key: "maturityYears",
    header: "Years",
    align: "right" as const,
    format: (value: unknown) => Number(value).toFixed(2).replace(/\.00$/, ""),
  },
  { key: "yield", header: "Yield", align: "right" as const, format: percent },
  { key: "asOf", header: "As of" },
];
const COMPARE_COLUMNS = [
  ...COLUMNS,
  { key: "compare", header: "Compare", align: "right" as const, format: percent },
  { key: "changeBasisPoints", header: "Chg bp", align: "right" as const, format: basisPoints },
];
const WORLD_COLUMNS = [
  { key: "market", header: "Market" },
  { key: "twoYear", header: "2Y", align: "right" as const, format: percent },
  { key: "tenYear", header: "10Y", align: "right" as const, format: percent },
  { key: "thirtyYear", header: "30Y", align: "right" as const, format: percent },
  { key: "twosTensBasisPoints", header: "2s10s bp", align: "right" as const, format: basisPoints },
  { key: "tenYearChangeBasisPoints", header: "10Y 1D bp", align: "right" as const, format: basisPoints },
  { key: "asOf", header: "As of" },
];

export interface YieldCurveHeadlessDependencies {
  load(curve: CurveId, requestedDate: string, context: HeadlessPaneContext): Promise<CurveData>;
  compare?(curve: CurveId, date: string, context: HeadlessPaneContext): Promise<YieldPoint[]>;
  world?(context: HeadlessPaneContext): Promise<WorldRow[]>;
}

const defaultDependencies: Required<YieldCurveHeadlessDependencies> = {
  load: (curve, requestedDate, context) => loadCurveData(curve, requestedDate, context.apiClient),
  compare: (curve, date, context) => loadComparePoints(curve, date, context.apiClient),
  world: (context) => loadWorldRows(context.apiClient),
};

const bp = (value: number | null) => value == null ? null : Math.round(value * 100);

/** The official publisher of each curve, as docs/research-data.md lists them. */
const CURVE_PUBLISHERS: Record<CurveId, string> = {
  us: "US Treasury",
  "us-real": "US Treasury",
  "us-breakeven": "US Treasury",
  "eu-aaa": "ECB",
  de: "Bundesbank",
  gb: "Bank of England",
  jp: "Japan Ministry of Finance",
  ca: "Bank of Canada",
};

export function createYieldCurveHeadless(
  dependencies: YieldCurveHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  const loadCompare = dependencies.compare ?? defaultDependencies.compare;
  const loadWorld = dependencies.world ?? defaultDependencies.world;
  return {
    shape: "rows",
    argument: { kind: "free-text", optional: true, placeholder: "[curve] [YYYY-MM-DD]",
      description: "A curve (ust, tips, breakeven, euro, bund, gilt, jgb, canada) and a historical as-of date; omit for the latest UST curve." },
    options: [
      { key: "date", type: "string", description: "Historical as-of date (YYYY-MM-DD); uses the latest session on or before it." },
      { key: "curve", type: "string", description: "ust (default), tips, breakeven, euro, bund, gilt, jgb or canada." },
      { key: "compare", type: "string", description: "Compare with a date (YYYY-MM-DD) or a span back from the curve's session (1W, 3M, 1Y)." },
      { key: "view", type: "enum", values: [{ value: "curve" }, { value: "difference", aliases: ["diff"] }],
        description: "With a compare date: both curves, or the bp change by tenor as bars.",
        pluginState: { pluginId: "macro", key: "yield-curve:view" } },
      { key: "forward", type: "boolean", description: "Overlay the one-year-forward curve on the chart.",
        pluginState: { pluginId: "macro", key: "yield-curve:forward" } },
      { key: "tab", type: "enum", values: [{ value: "curve" }, { value: "world" }],
        description: "curve (default), or world: each market's 2Y, 10Y, 30Y and 2s10s on its own latest session.",
        pluginState: { pluginId: "macro", key: "yield-curve:tab" } },
    ],
    columns: COLUMNS,
    describe: "Yield Curves",
    async load(args, context) {
      if (args.options.tab === "world") {
        const rows = await loadWorld(context);
        return {
          freshness: { source: "Government bond publishers", status: "not-a-feed", basis: "daily curves" },
          columns: WORLD_COLUMNS,
          rows: rows.map((row) => ({ market: row.market, twoYear: row.twoYear, tenYear: row.tenYear, thirtyYear: row.thirtyYear,
            twosTensBasisPoints: bp(row.twosTens), tenYearChangeBasisPoints: bp(row.tenYearChange), asOf: row.asOf })),
          metadata: { units: "Percent" },
        };
      }
      const argument = parseCurveArgument(args.argument);
      const optionCurve = args.options.curve == null || args.options.curve === "" ? null : curveIdOf(args.options.curve);
      if (args.options.curve && !optionCurve) {
        throw new Error(`Unknown curve ${String(args.options.curve)}; use ${CURVE_OPTIONS.map((option) => option.aliases[0]).join(", ")}.`);
      }
      const curve = optionCurve ?? argument.curve ?? "us";
      const requestedDate = args.options.date != null ? yieldCurveDate(args.options.date) : argument.date;
      const compareInput = args.options.compare == null ? "" : parseCompareInput(String(args.options.compare));
      const data = await dependencies.load(curve, requestedDate, context);
      const points = data.points;
      const session = curveAsOf(points);
      const comparePoints = compareInput && session ? await loadCompare(curve, compareDate(compareInput, session), context) : null;
      const compareAt = (maturity: string) => comparePoints?.find((point) => point.maturity === maturity)?.yield ?? null;
      const rows = [...points].sort((a, b) => a.maturityYears - b.maturityYears);
      const missingTenors = points.filter((point) => point.yield == null).map((point) => point.maturity);
      const spreads = curveSpreadFigures(data, data.lookbacks ?? {});
      const spread = (id: string) => bp(spreads.find((entry) => entry.id === id)?.value ?? null);
      const twosTens = spread("2s10s");
      return {
        // Each curve is its official publisher's daily close; a past date is a historical curve, not a feed.
        freshness: { source: CURVE_PUBLISHERS[curve], status: "not-a-feed",
          ...(requestedDate ? { basis: "historical curve" } : { basis: "daily curve", cadence: "daily" }) },
        ...(comparePoints ? { columns: COMPARE_COLUMNS } : {}),
        rows: rows.map((point) => {
          const compare = compareAt(point.maturity);
          return comparePoints
            ? { ...point, compare, changeBasisPoints: point.yield != null && compare != null ? (point.yield - compare) * 100 : null }
            : { ...point };
        }),
        errors: [
          ...yieldCurveErrors(points),
          ...(missingTenors.length ? [`Tenors unavailable: ${missingTenors.join(", ")}`] : []),
          ...(!session ? ["Curve has mixed or unknown observation dates."] : []),
          ...(points.some((point) => point.stale) ? ["Some Treasury sources are stale cached data."] : []),
        ],
        metadata: {
          curve,
          label: curveOption(curve).label,
          units: "Percent",
          requestedDate: requestedDate || null,
          asOf: session,
          ...(comparePoints ? { compareAsOf: curveAsOf(comparePoints) } : {}),
          inverted: twosTens == null ? null : twosTens < 0,
          spread2Y10YBasisPoints: twosTens,
          spread3M10YBasisPoints: spread("3m10y"),
          spread5Y30YBasisPoints: spread("5s30s"),
          spreadPercentiles1Y: Object.fromEntries(spreads.map((entry) => [entry.id, entry.percentile1y])),
          missingTenors,
          stale: points.some((point) => point.stale),
        },
      };
    },
  };
}

export const yieldCurveHeadless = createYieldCurveHeadless();
