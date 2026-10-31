import type { ManualChartResolution } from "../resolution";
import type { ChartStudySpec, ResolvedSeries } from "../types";
import { studyMessageName } from "../series-name";
import {
  dailyLeverageGrowth,
  leverageDecayPoints,
  leverageFactorLabel,
  leverageSymbol,
  sessionCloses,
  type StudyAnchor,
} from "../leverage";
import { DECAY_COLORS, derivedPoint, outputSeries } from "./shared";

/** The objective's line and its decay compound session returns: they need daily bars, whatever the chart's range. */
export function dailyBarsIssue(spec: ChartStudySpec, input: ResolvedSeries, marketResolution: ManualChartResolution | undefined): string | null {
  const resolution = input.historyResolution === undefined ? marketResolution : input.historyResolution;
  if (input.nativeFrequency === "daily" && (resolution === undefined || resolution === "1d")) return null;
  return `${studyMessageName(spec)}: ${leverageFactorLabel(Number(spec.parameters.factor))} daily needs daily bars. Choose D bars.`;
}

/**
 * The line a leveraged or inverse fund's daily objective draws from its index
 * fund, in percent from where the chart compares (3× daily QQQ beside TQQQ),
 * on the percent axis the compared legs share.
 */
export function resolveLeverageLine(spec: ChartStudySpec, index: ResolvedSeries, color: string, anchor: StudyAnchor | undefined): ResolvedSeries[] {
  const factor = spec.parameters.factor as number;
  const closes = sessionCloses(index, anchor);
  const growth = dailyLeverageGrowth(closes.map((entry) => entry.close), factor);
  return [outputSeries(spec, index, {
    label: `${leverageFactorLabel(factor)} daily ${leverageSymbol(index)}`,
    points: closes.map((entry, position) => derivedPoint({ point: entry.point, value: entry.close }, (growth[position]! - 1) * 100)),
    color,
    unit: "%",
    unitGroup: "percent",
    statedUnit: null,
    priceAssetCategory: null,
    axis: "left",
  })];
}

/**
 * How far the fund falls short of its daily objective, in percentage points
 * from where the chart compares: the fund against the daily line (fees,
 * financing, tracking), and the daily line against the factor times the index
 * fund's return over the period (compounding, which daily resets cost in a
 * market that swings).
 */
export function resolveLeverageDecay(
  spec: ChartStudySpec,
  fund: ResolvedSeries,
  index: ResolvedSeries,
  anchors: ReadonlyMap<string, StudyAnchor> | undefined,
): ResolvedSeries[] {
  const factor = spec.parameters.factor as number;
  const decay = leverageDecayPoints(sessionCloses(fund, anchors?.get(fund.id)), sessionCloses(index, anchors?.get(index.id)), factor);
  const daily = `${leverageFactorLabel(factor)} daily`;
  const line = (id: string, label: string, color: string, value: (point: (typeof decay)[number]) => number) => outputSeries(spec, fund, {
    id: `${spec.id}:${id}`,
    label,
    points: decay.map((entry) => derivedPoint({ point: entry.point, value: entry.fund }, value(entry))),
    color: spec.color ?? color,
    unit: "pp",
    // Not a percent group: a difference of returns reads in points (-0.96 pp), not as a return.
    unitGroup: "pp",
    statedUnit: null,
    priceAssetCategory: null,
    axis: "left",
  });
  return [
    line("fund", `${leverageSymbol(fund)} decay vs ${daily} ${leverageSymbol(index)}`, DECAY_COLORS[0], (entry) => entry.fund - entry.daily),
    // `3× QQQ`: three times QQQ's return over the period, the multiple a daily reset does not deliver.
    line("compounding", `${daily} ${leverageSymbol(index)} decay vs ${leverageFactorLabel(factor)} ${leverageSymbol(index)}`, DECAY_COLORS[1], (entry) => entry.daily - entry.period),
  ];
}
