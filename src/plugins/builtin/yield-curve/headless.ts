import type {
  HeadlessPaneContext,
  HeadlessPaneDefinition,
} from "../../../types/plugin";
import {
  compareDate, CURVE_OPTIONS, curveIdOf, curveOption, curveSpreadFigures, loadComparePoints, loadCurveData, parseCompareInput,
  parseCurveArgument, type CurveData, type CurveId,
} from "./curves";
import { yieldTenorRows, type YieldLookbackCurves } from "./chart";
import { curveAsOf, type YieldPoint, yieldCurveErrors } from "./treasury-data";
import { loadYieldCurveLookbacks, yieldCurveDate } from "./history";
import { loadWorldRows, type WorldRow } from "./world";
import { formatBasisPoints, toBasisPoints } from "../../../utils/basis-points";

const percent = (value: unknown) => value == null ? "-" : `${Number(value).toFixed(2)}%`;
/** A move already in basis points: `+3bp`, `-1bp`, `0bp`. */
const basisPoints = (value: unknown) => value == null ? "-" : formatBasisPoints(Number(value) / 100);
const MATURITY_COLUMNS = [
  { key: "maturity", header: "Maturity" },
  {
    key: "maturityYears",
    header: "Years",
    align: "right" as const,
    format: (value: unknown) => Number(value).toFixed(2).replace(/\.00$/, ""),
  },
  { key: "yield", header: "Yield", align: "right" as const, format: percent },
];
const AS_OF_COLUMN = { key: "asOf", header: "As of" };
/** The move since the previous session with a yield, per tenor. */
const COLUMNS = [
  ...MATURITY_COLUMNS,
  { key: "change1dBasisPoints", header: "1D bp", align: "right" as const, format: basisPoints },
  AS_OF_COLUMN,
];
/** Both curves and the difference; the compare curve's own session heads its column, as it may be a day or a year back. */
const compareColumns = (compareAsOf: string | null) => [
  ...MATURITY_COLUMNS,
  AS_OF_COLUMN,
  { key: "compare", header: compareAsOf ? `vs ${compareAsOf}` : "Compare", align: "right" as const, format: percent },
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
  /** The 1D, 1W and 1M curves of a session, for a curve loaded without them (the FRED fallback). */
  lookbacks?(session: string, context: HeadlessPaneContext): Promise<YieldLookbackCurves>;
  world?(context: HeadlessPaneContext): Promise<WorldRow[]>;
}

const defaultDependencies: Required<YieldCurveHeadlessDependencies> = {
  load: (curve, requestedDate, context) => loadCurveData(curve, requestedDate, context.apiClient),
  compare: (curve, date, context) => loadComparePoints(curve, date, context.apiClient),
  lookbacks: async (session, context) => Object.fromEntries(
    (await loadYieldCurveLookbacks(session, (id, options) => context.apiClient.getCloudFredSeries(id, options)))
      .map((lookback) => [lookback.id, lookback.points]),
  ),
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

/** Whose business days each curve's dates are, so a report names the day it means. */
const CURVE_MARKETS: Record<CurveId, string> = {
  us: "US",
  "us-real": "US",
  "us-breakeven": "US",
  "eu-aaa": "Euro area",
  de: "Germany",
  gb: "UK",
  jp: "Japan",
  ca: "Canada",
};

export function createYieldCurveHeadless(
  dependencies: YieldCurveHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  const loadCompare = dependencies.compare ?? defaultDependencies.compare;
  const loadLookbacks = dependencies.lookbacks ?? defaultDependencies.lookbacks;
  const loadWorld = dependencies.world ?? defaultDependencies.world;
  return {
    shape: "rows",
    argument: { kind: "free-text", optional: true, placeholder: "[curve] [YYYY-MM-DD]",
      description: "A curve (ust, tips, breakeven, euro, bund, gilt, jgb, canada) and a historical as-of date; omit for the latest UST curve." },
    options: [
      { key: "date", type: "string", description: "Historical as-of date (YYYY-MM-DD); uses the latest session on or before it." },
      { key: "curve", type: "string", description: "ust (default), tips, breakeven, euro, bund, gilt, jgb or canada." },
      { key: "compare", type: "string", description: "Compare with a date (YYYY-MM-DD) or a span back from the curve's session (1D, 1W, 1M, 3M, 1Y)." },
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
    // The title names the curve, as the pane's Curve select does.
    describe: (args) => {
      if (args.options.tab === "world") return "Yield Curves | World";
      try {
        const curve = curveIdOf(args.options.curve) ?? parseCurveArgument(args.argument).curve ?? "us";
        return `Yield Curves | ${curveOption(curve).label}`;
      } catch {
        return "Yield Curves";
      }
    },
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
      const compareAsOf = comparePoints ? curveAsOf(comparePoints) : null;
      const compareAt = (maturity: string) => comparePoints?.find((point) => point.maturity === maturity)?.yield ?? null;
      // The stored curve brings its look-backs; the FRED fallback's load after it, and a failure leaves the move blank.
      const lookbacks = data.lookbacks ?? (session ? await loadLookbacks(session, context).catch(() => ({})) : {});
      const change1d = new Map(yieldTenorRows(points, lookbacks).map((row) => [row.id, row.change1d]));
      const rows = [...points].sort((a, b) => a.maturityYears - b.maturityYears);
      const missing = points.filter((point) => point.yield == null);
      const missingTenors = missing.map((point) => point.maturity);
      // On a past date a tenor the publisher has no yield for was most likely not issued yet: a note, not an error.
      const notIssued = requestedDate && missing.length < points.length ? missing.filter((point) => !point.error).map((point) => point.maturity) : [];
      const unavailable = missingTenors.filter((maturity) => !notIssued.includes(maturity));
      const spreads = curveSpreadFigures(data, lookbacks);
      const spread = (id: string) => bp(spreads.find((entry) => entry.id === id)?.value ?? null);
      const twosTens = spread("2s10s");
      return {
        // Each curve is its official publisher's daily close; a past date is a historical curve, not a feed.
        freshness: { source: CURVE_PUBLISHERS[curve], status: "not-a-feed", tradingDayMarket: CURVE_MARKETS[curve],
          ...(requestedDate ? { basis: "historical curve" } : { basis: "daily curve", cadence: "daily" }) },
        ...(comparePoints ? { columns: compareColumns(compareAsOf) } : {}),
        rows: rows.map((point) => {
          const compare = compareAt(point.maturity);
          const change = change1d.get(point.maturity) ?? null;
          return {
            ...point,
            change1dBasisPoints: change == null ? null : toBasisPoints(change, 1),
            ...(comparePoints
              ? { compare, changeBasisPoints: point.yield != null && compare != null ? (point.yield - compare) * 100 : null }
              : {}),
          };
        }),
        ...(notIssued.length ? { notes: [`Not issued then: ${notIssued.join(", ")}`] } : {}),
        errors: [
          ...yieldCurveErrors(points),
          ...(unavailable.length ? [`Tenors unavailable: ${unavailable.join(", ")}`] : []),
          ...(!session ? ["Curve has mixed or unknown observation dates."] : []),
          ...(points.some((point) => point.stale) ? ["Some Treasury sources are stale cached data."] : []),
        ],
        metadata: {
          curve,
          label: curveOption(curve).label,
          units: "Percent",
          requestedDate: requestedDate || null,
          asOf: session,
          ...(comparePoints ? { compare: compareInput, compareAsOf } : {}),
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
