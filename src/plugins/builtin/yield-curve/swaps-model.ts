import { SWAP_TENORS, type SwapCurvePayload, type SwapPoint, type SwapTenor } from "../../../api-client/swap-curve";
import type { CurveSeries } from "../../../components/chart/curve";
import { staticSeries } from "../../../components/chart/static/series";

const finite = (value: unknown) => value === null || typeof value === "number" && Number.isFinite(value);
const count = (value: number) => Number.isInteger(value) && value >= 0;
const date = (value: unknown) => value === null || typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const quality = (value: unknown) => value === "ok" || value === "thin" || value === "missing";

/** Reject incompatible observations before they replace the last usable cache. */
export function validateSwapCurve(payload: SwapCurvePayload): SwapCurvePayload {
  const invalid = () => { throw new Error("The server returned invalid SOFR swap observations"); };
  if (!payload || payload.currency !== "USD" || payload.benchmark !== "SOFR" || typeof payload.stale !== "boolean"
    || !date(payload.asOf) || !date(payload.previousDate) || !date(payload.treasuryDate)
    || !payload.comparisons?.week || !payload.comparisons.month || !payload.history
    || !SWAP_TENORS.includes(payload.history.tenor) || !Array.isArray(payload.history.points)) return invalid();
  for (const snapshot of [{ date: payload.asOf, points: payload.points }, payload.comparisons.week, payload.comparisons.month]) {
    if (!date(snapshot.date) || !Array.isArray(snapshot.points)
      || new Set(snapshot.points.map((point) => point.tenor)).size !== snapshot.points.length) return invalid();
    for (const point of snapshot.points) {
      if (!SWAP_TENORS.includes(point.tenor) || point.years !== Number.parseInt(point.tenor)
        || !finite(point.rate) || !finite(point.changeBp) || !finite(point.spreadBp) || !finite(point.treasuryRate)
        || !count(point.tradeCount) || !count(point.candidateCount) || !count(point.excludedCount)
        || !Number.isFinite(point.notionalUsd) || point.notionalUsd < 0 || !quality(point.quality)
        || point.rate != null && (snapshot.date == null || point.tradeCount < 3 || point.quality === "missing")
        || point.rate == null && (point.changeBp != null || point.spreadBp != null)
        || point.tenor === "15Y" && point.spreadBp != null) return invalid();
    }
  }
  if (payload.points.length !== SWAP_TENORS.length) return invalid();
  let previous = "";
  for (const point of payload.history.points) {
    if (point.date == null || !date(point.date) || point.date <= previous || !finite(point.rate) || !finite(point.spreadBp)
      || !count(point.tradeCount) || !quality(point.quality)
      || point.rate != null && (point.tradeCount < 3 || point.quality === "missing")
      || point.rate == null && point.spreadBp != null
      || payload.history.tenor === "15Y" && point.spreadBp != null) return invalid();
    previous = point.date;
  }
  return payload;
}

export function selectedSwapTenor(value: unknown): SwapTenor {
  return SWAP_TENORS.includes(value as SwapTenor) ? value as SwapTenor : "10Y";
}

const curvePoints = (points: readonly SwapPoint[]) => points.map((point) => ({
  id: point.tenor, label: point.tenor, x: point.years, value: point.rate,
}));

/** Missing tenors remain null nodes, which break the line instead of bridging the gap. */
export function swapCurveSeries(payload: SwapCurvePayload,
  colors: { current: string; ghosts: Readonly<Record<string, string>> }): CurveSeries[] {
  return [
    { id: "sofr", label: "SOFR", role: "primary", color: colors.current, points: curvePoints(payload.points) },
    ...(["week", "month"] as const).flatMap((key): CurveSeries[] => {
      const snapshot = payload.comparisons[key];
      const id = key === "week" ? "1W" : "1M";
      return snapshot.date == null ? [] : [{ id, label: id, role: "ghost", asOf: snapshot.date,
        color: colors.ghosts[id], points: curvePoints(snapshot.points) }];
    }),
  ];
}

/** Preserve missing sessions and their null values on the calendar axis. */
export function swapHistorySeries(history: SwapCurvePayload["history"], color: string) {
  return [staticSeries(history.points.map((point) => ({ date: new Date(point.date), observedAt: new Date(point.date), value: point.rate })),
    { id: `sofr-${history.tenor}`, label: `${history.tenor} SOFR`, color, calendarSpaced: true })];
}

/** Already in basis points: never multiply a swap change or spread by 100 again. */
export function formatSwapBp(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}bp`;
}
