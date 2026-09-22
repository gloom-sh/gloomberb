import { expect, test } from "bun:test";
import { buildVolatilityData } from "./model";
import { readVolatilityEvidence, volatilitySemanticEvidence } from "./evidence";
import type { VolatilityLoadResult } from "./client";

const result = (): VolatilityLoadResult => ({
  data: buildVolatilityData({ fred: {
    VIXCLS: { info: null, observations: [{ date: "2026-09-18", value: 20 }, { date: "2026-09-19", value: null }, { date: "2026-09-21", value: 22 }] },
    VXVCLS: { info: null, observations: [{ date: "2026-09-18", value: 23 }, { date: "2026-09-19", value: 24 }, { date: "2026-09-21", value: 25 }] },
  } }), stale: false, errors: [], phase: "partial", loaded: 22, total: 22,
});

test("history evidence proves plotted legs, dated ratios and gaps independently of unavailable board sources", () => {
  const evidence = volatilitySemanticEvidence(result(), "history", null, false);
  expect(evidence.complete).toBe(true);
  expect(evidence.plottedValueCount).toBe(7);
  expect(evidence.series.map((entry) => entry.points.map((point) => point.value))).toEqual([
    [20, null, 22], [23, 24, 25], [23 / 20, null, 25 / 22],
  ]);
  expect(readVolatilityEvidence(JSON.parse(JSON.stringify(evidence)))).toEqual(evidence);
  const wrongRatio = structuredClone(evidence);
  wrongRatio.series[2]!.points[0]!.value = 1.5;
  expect(readVolatilityEvidence(wrongRatio)).toBeNull();
  const wrongDate = structuredClone(evidence);
  wrongDate.series[2]!.points[0]!.date = "2026-09-17T00:00:00.000Z";
  expect(readVolatilityEvidence(wrongDate)).toBeNull();
  expect(readVolatilityEvidence({ ...evidence, plottedValueCount: 100 })).toBeNull();
});

test("loading, stale FRED and missing curve tenors cannot claim complete evidence", () => {
  expect(volatilitySemanticEvidence(result(), "history", null, true).complete).toBe(false);
  const stale = result();
  stale.data.fred.metrics[0]!.stale = true;
  const history = volatilitySemanticEvidence(stale, "history", null, false);
  expect(history.complete).toBe(false);
  expect(readVolatilityEvidence({ ...history, complete: true })).toBeNull();
  const partial = result();
  partial.data = buildVolatilityData({ history: {
    vix: { source: "router", history: [{ date: new Date("2026-09-21"), close: 22 }] },
    vix3m: { source: "router", history: [{ date: new Date("2026-09-21"), close: 25 }] },
  } });
  const curve = volatilitySemanticEvidence(partial, "curve", null, false);
  expect(curve.complete).toBe(false);
  expect(curve.plottedValueCount).toBe(2);
  expect(curve.unavailableSources).toEqual(["vix9d", "vix6m", "vix1y"]);
  expect(readVolatilityEvidence(curve)).not.toBeNull();
  expect(readVolatilityEvidence({ ...curve, complete: true, unavailableSources: [] })).toBeNull();
  expect(readVolatilityEvidence(volatilitySemanticEvidence(null, "history", null, false))).toBeNull();
});
