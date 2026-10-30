import type {
  HeadlessPaneContext,
  HeadlessPaneDefinition,
} from "../../../types/plugin";
import {
  compareDate, curveCutoff, curveIdOf, curveOption, curveSpreadFigures, curveTenorMove, loadComparePoints,
  parseCompareInput, parseCurveArgument, unknownCurveMessage, type CurveData, type CurveId,
} from "./curves";
import { yieldTenorRows, type YieldLookbackCurves } from "./chart";
import { curveAsOf, type YieldPoint, yieldCurveErrors } from "./treasury-data";
import { loadYieldCurveLookbacks, yieldCurveDate } from "./history";
import type { WorldRow } from "./world";
import { formatBasisPoints, toBasisPoints } from "../../../utils/basis-points";
import { DATE_OPTION_EXAMPLES } from "../../../utils/calendar-date";
import { SWAP_TENORS, type SwapCurvePayload, type SwapTenor } from "../../../api-client/swap-curve";
import { fetchSwapCurve, loadSavedCurve, loadSavedWorldRows } from "./client";
import { savedCopyMark } from "../../../data/saved-copies";
import { formatSwapBp, selectedSwapTenor } from "./swaps-model";

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
const percentile = (value: unknown) => value == null ? "-" : Number(value).toFixed(0);
/**
 * With Gloom Cloud's move ranks: each tenor's 1D and 1W move, how big it was
 * against every move of its kind (a percentile), and the year that history
 * starts, which differs by tenor (the 6W bill began in 2025).
 */
const RANKED_COLUMNS = [
  ...MATURITY_COLUMNS,
  { key: "change1dBasisPoints", header: "1D bp", align: "right" as const, format: basisPoints },
  { key: "move1dPercentile", header: "1D pctl", align: "right" as const, format: percentile },
  { key: "change1wBasisPoints", header: "1W bp", align: "right" as const, format: basisPoints },
  { key: "move1wPercentile", header: "1W pctl", align: "right" as const, format: percentile },
  { key: "movesSince", header: "Since", format: (value: unknown) => typeof value === "string" ? value.slice(0, 4) : "-" },
  AS_OF_COLUMN,
];
const RANK_NOTE = "pctl is the share of the tenor's 1D (or 1W) moves since the year in Since that were smaller, ties counted half.";
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
const SWAP_COLUMNS = [
  { key: "tenor", header: "Tenor" },
  { key: "rate", header: "Rate %", align: "right" as const, format: percent },
  { key: "changeBp", header: "1D bp", align: "right" as const, format: (value: unknown) => value == null ? "-" : formatSwapBp(Number(value)) },
  { key: "spreadBp", header: "Spread bp", align: "right" as const, format: (value: unknown) => value == null ? "-" : formatSwapBp(Number(value)) },
  { key: "tradeCount", header: "Trades", align: "right" as const,
    format: (value: unknown, row: Record<string, unknown>) => `${value}${row.quality === "thin" ? " Thin" : ""}` },
];

export interface YieldCurveHeadlessDependencies {
  load(curve: CurveId, requestedDate: string, context: HeadlessPaneContext): Promise<CurveData>;
  compare?(curve: CurveId, date: string, context: HeadlessPaneContext): Promise<YieldPoint[]>;
  /** The 1D, 1W and 1M curves of a session, for a curve loaded without them (the FRED fallback). */
  lookbacks?(session: string, context: HeadlessPaneContext): Promise<YieldLookbackCurves>;
  world?(context: HeadlessPaneContext): Promise<WorldRow[]>;
  swaps?(tenor: SwapTenor, context: HeadlessPaneContext): Promise<SwapCurvePayload>;
}

const defaultDependencies: Required<YieldCurveHeadlessDependencies> = {
  // A curve that cannot be read is the copy an earlier read saved, marked so the report says so.
  load: async (curve, requestedDate, context) => (await loadSavedCurve(curve, requestedDate, context.apiClient)).data,
  compare: (curve, date, context) => loadComparePoints(curve, date, context.apiClient),
  lookbacks: async (session, context) => Object.fromEntries(
    (await loadYieldCurveLookbacks(session, (id, options) => context.apiClient.getCloudFredSeries(id, options)))
      .map((lookback) => [lookback.id, lookback.points]),
  ),
  world: async (context) => (await loadSavedWorldRows(context.apiClient)).data,
  swaps: (tenor, context) => fetchSwapCurve(tenor, context.apiClient),
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
  const loadSwaps = dependencies.swaps ?? defaultDependencies.swaps;
  return {
    shape: "rows",
    argument: { kind: "free-text", optional: true, placeholder: "[curve] [date]",
      description: "A curve (ust, tips, breakeven, euro, bund, gilt, jgb, canada) and a historical as-of date; omit for the latest UST curve." },
    options: [
      { key: "date", type: "string", settingKey: "asOfDate", placeholder: "date", description: `Historical as-of date, as ${DATE_OPTION_EXAMPLES}; uses the latest session on or before it.` },
      { key: "curve", type: "string", description: "ust (default), tips, breakeven, euro, bund, gilt, jgb or canada." },
      { key: "compare", type: "string", description: `Compare with a date (${DATE_OPTION_EXAMPLES}) or a span back from the curve's session (1D, 1W, 1M, 3M, 1Y).` },
      { key: "view", type: "enum", values: [{ value: "curve" }, { value: "difference", aliases: ["diff"] }],
        description: "With a compare date: both curves, or the bp change by tenor as bars.",
        pluginState: { pluginId: "macro", key: "yield-curve:view" } },
      { key: "forward", type: "boolean", description: "Overlay the one-year-forward curve on the chart.",
        pluginState: { pluginId: "macro", key: "yield-curve:forward" } },
      { key: "tab", type: "enum", values: [{ value: "curve" }, { value: "world" }, { value: "swaps" }],
        description: "curve (default), world (government yields), or swaps (USD SOFR rates and Treasury swap spreads). Spreads use native quotes: annual ACT/360 OIS versus semiannual bond-equivalent Treasury yields.",
        pluginState: { pluginId: "macro", key: "yield-curve:tab" } },
      { key: "tenor", type: "enum", values: SWAP_TENORS.map((value) => ({ value })),
        description: "Swaps history tenor (default 10Y); the curve table always includes every tenor.",
        pluginState: { pluginId: "macro", key: "yield-curve:swap-tenor" } },
      { key: "swap-view", type: "enum", values: [{ value: "curve" }, { value: "history" }],
        description: "Swaps chart: current curve with 1W/1M comparisons, or the selected tenor's history.",
        pluginState: { pluginId: "macro", key: "yield-curve:swap-view" } },
    ],
    columns: COLUMNS,
    // The title names the curve, as the pane's Curve select does.
    describe: (args) => {
      if (args.options.tab === "world") return "Yield Curves | World";
      if (args.options.tab === "swaps") return "Yield Curves | USD SOFR Swaps";
      try {
        const curve = curveIdOf(args.options.curve) ?? parseCurveArgument(args.argument).curve ?? "us";
        return `Yield Curves | ${curveOption(curve).label}`;
      } catch {
        return "Yield Curves";
      }
    },
    async load(args, context) {
      if (args.options.tab === "swaps") {
        const data = await loadSwaps(selectedSwapTenor(args.options.tenor), context);
        return {
          freshness: { source: "DTCC public swap reports", status: "not-a-feed", basis: "daily trade estimates", cadence: "daily",
            tradingDayMarket: "US" },
          columns: SWAP_COLUMNS,
          rows: (data.asOf ? data.points : []).map((point) => ({ ...point, asOf: data.asOf })),
          metadata: { currency: data.currency, benchmark: data.benchmark, units: "Percent", changeUnit: "Basis points",
            asOf: data.asOf, fetchedAt: data.fetchedAt, stale: data.stale, previousDate: data.previousDate,
            treasuryDate: data.treasuryDate, comparisons: data.comparisons, history: data.history },
          errors: !data.asOf ? ["No swap rates yet."] : data.stale ? ["The swap curve is stale."] : [],
        };
      }
      if (args.options.tab === "world") {
        const rows = await loadWorld(context);
        return {
          freshness: { source: "Government bond publishers", status: "not-a-feed", basis: "daily curves" },
          columns: WORLD_COLUMNS,
          rows: rows.map((row) => ({ ...savedCopyMark(row), market: row.market, twoYear: row.twoYear, tenYear: row.tenYear, thirtyYear: row.thirtyYear,
            twosTensBasisPoints: bp(row.twosTens), tenYearChangeBasisPoints: bp(row.tenYearChange), asOf: row.asOf })),
          metadata: { units: "Percent" },
        };
      }
      const argument = parseCurveArgument(args.argument);
      const optionCurve = args.options.curve == null || args.options.curve === "" ? null : curveIdOf(args.options.curve);
      if (args.options.curve && !optionCurve) {
        throw new Error(unknownCurveMessage(String(args.options.curve)));
      }
      const curve = optionCurve ?? argument.curve ?? "us";
      const requestedDate = args.options.date != null ? yieldCurveDate(args.options.date, new Date(), "--date") : argument.date;
      const compareInput = args.options.compare == null ? "" : parseCompareInput(String(args.options.compare), new Date(), "--compare");
      const data = await dependencies.load(curve, requestedDate, context);
      const points = data.points;
      const session = curveAsOf(points);
      const comparePoints = compareInput && session ? await loadCompare(curve, compareDate(compareInput, session), context) : null;
      const compareAsOf = comparePoints ? curveAsOf(comparePoints) : null;
      const compareAt = (maturity: string) => comparePoints?.find((point) => point.maturity === maturity)?.yield ?? null;
      // The stored curve brings its look-backs; the FRED fallback's load after it, and a failure leaves the move blank.
      const lookbacks: YieldLookbackCurves = data.lookbacks ?? (session ? await loadLookbacks(session, context).catch(() => ({})) : {});
      const tenorRows = new Map(yieldTenorRows(points, lookbacks).map((row) => [row.id, row]));
      const rows = [...points].sort((a, b) => a.maturityYears - b.maturityYears);
      const missing = points.filter((point) => point.yield == null);
      const missingTenors = missing.map((point) => point.maturity);
      // A blank on a past date is not evidence the tenor was unissued. Leave the cell empty.
      const pastBlanks = requestedDate && missing.length < points.length
        ? missing.filter((point) => !point.error).map((point) => point.maturity) : [];
      const unavailable = missingTenors.filter((maturity) => !pastBlanks.includes(maturity));
      const spreads = curveSpreadFigures(data, lookbacks);
      const spread = (id: string) => bp(spreads.find((entry) => entry.id === id)?.value ?? null);
      const twosTens = spread("2s10s");
      const fredNames = new Set<string>();
      for (const curvePoints of [points, ...Object.values(lookbacks)]) {
        for (const point of curvePoints ?? []) {
          const source = point.source?.trim();
          if (source) fredNames.add(source);
        }
      }
      // Gloom Cloud ranks the stored curve's moves; the FRED fallback and older servers bring none.
      const ranked = !comparePoints && (data.moves?.some((move) => move.change != null) ?? false);
      const seriesSource = fredNames.size > 0 ? [...fredNames].join(", ")
        : data.seriesSource ? data.seriesSource
        : data.seriesSource === null ? "FRED" : CURVE_PUBLISHERS[curve];
      const cutoff = curveCutoff(curve);
      return {
        // A stored curve cites its publisher. FRED's fallback cites info.source, not that publisher.
        // A Treasury curve names when in the day it was taken, beside its date.
        freshness: { source: seriesSource, status: "not-a-feed", tradingDayMarket: CURVE_MARKETS[curve],
          ...(cutoff ? { schedule: cutoff } : {}),
          ...(requestedDate ? { basis: "historical curve" } : { basis: "daily curve", cadence: "daily" }) },
        ...(comparePoints ? { columns: compareColumns(compareAsOf) } : ranked ? { columns: RANKED_COLUMNS } : {}),
        ...(ranked ? { notes: [RANK_NOTE] } : {}),
        rows: rows.map((point) => {
          const compare = compareAt(point.maturity);
          const change = tenorRows.get(point.maturity)?.change1d ?? null;
          const change1w = tenorRows.get(point.maturity)?.change1w ?? null;
          const day = ranked ? curveTenorMove(data, point.maturity, "1D") : null;
          const week = ranked ? curveTenorMove(data, point.maturity, "1W") : null;
          return {
            ...savedCopyMark(data),
            ...point,
            change1dBasisPoints: change == null ? null : toBasisPoints(change, 1),
            ...(ranked ? {
              change1wBasisPoints: change1w == null ? null : toBasisPoints(change1w, 1),
              move1dPercentile: day?.percentile ?? null,
              move1wPercentile: week?.percentile ?? null,
              // Both horizons' histories start within a week of each other; the day's names the year.
              movesSince: day?.since ?? week?.since ?? null,
            } : {}),
            ...(comparePoints
              ? { compare, changeBasisPoints: point.yield != null && compare != null ? (point.yield - compare) * 100 : null }
              : {}),
          };
        }),
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
