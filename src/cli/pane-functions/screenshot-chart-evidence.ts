import { CHART_COMPOSER_PANE_ID } from "../../types/config";
import type { PricePoint, TickerFinancials } from "../../types/financials";
import { isRecord } from "../../utils/guards";
import type { DesktopPaneShotPayload } from "../desktop-pane-shot";
import type { ResolvedPaneFunction } from "./resolver";
import type { RemoteUiNodeSnapshot } from "../../remote/types";
import type { TimeRange } from "../../time-series/range";
import { appendLiveQuotePoint } from "../../time-series/chart-data";
import { subtractTimeRange } from "../../time-series/date-window";
import { buildPresetDateWindow, getVisibleWindowForDateRange } from "../../components/chart/core/date-window";
import { parseChartSpec } from "../../plugins/builtin/chart-composer/chart-spec";
import { publicTickerKey } from "../../utils/exchanges";
import type { ResolvedSeries } from "../../time-series/types";
import { clipPriceHistoryToRange } from "./data";
import type {
  PaneScreenshotChartPointEvidence,
  PaneScreenshotChartSeriesEvidence,
  PaneScreenshotExpectedChartEvidence,
} from "./screenshot-types";

export function normalizeChartSeries(
  symbol: string,
  financials: TickerFinancials,
  range: TimeRange,
): {
  evidence: PaneScreenshotChartSeriesEvidence;
  points: Array<{ date: Date; close: number }>;
} {
  const sorted = clipPriceHistoryToRange(financials.priceHistory, range)
    .flatMap((point) => {
      const date = new Date(point.date);
      return Number.isFinite(date.getTime()) ? [{ ...point, date }] : [];
    })
    .sort((left, right) => left.date.getTime() - right.date.getTime());
  const points = appendLiveQuotePoint(sorted, financials.quote, { assetCategory: financials.quoteMetadata?.instrumentType })
    .slice()
    .sort((left, right) => new Date(left.date).getTime() - new Date(right.date).getTime());
  return {
    points,
    evidence: chartSeriesEvidence(symbol, points),
  };
}

export function chartSeriesEvidence(
  symbol: string,
  points: PricePoint[],
): PaneScreenshotChartSeriesEvidence {
  const pointEvidence = (
    point: typeof points[number] | undefined,
  ): PaneScreenshotChartPointEvidence | null => (
    point && Number.isFinite(point.date.getTime())
      ? { date: point.date.toISOString(), close: point.close }
      : null
  );
  return {
    symbol,
    pointCount: points.length,
    first: pointEvidence(points[0]),
    last: pointEvidence(points.at(-1)),
  };
}

export function chartSeriesEvidenceWithinRange(
  symbol: string,
  points: PricePoint[],
  range: TimeRange,
): PaneScreenshotChartSeriesEvidence {
  const dateWindow = buildPresetDateWindow(points.map(({ date }) => date), range);
  const visiblePoints = getVisibleWindowForDateRange(points, dateWindow, 0).points;
  return chartSeriesEvidence(symbol, visiblePoints);
}

export function shotExpectedChart(
  resolved: ResolvedPaneFunction,
  payload: DesktopPaneShotPayload,
): PaneScreenshotExpectedChartEvidence | null {
  if (resolved.pane.id === CHART_COMPOSER_PANE_ID) {
    const spec = parseChartSpec(resolved.instance.settings?.chartSpec);
    if (!spec) return null;
    const capabilityPoint = (point: ResolvedSeries["points"][number] | undefined) => point
      ? {
          date: point.date.toISOString(),
          value: typeof (point.value ?? point.close) === "number" ? point.value ?? point.close ?? null : null,
        }
      : null;
    return {
      kind: "chart-composer",
      symbols: [...new Set(spec.series.flatMap((series) => (
        series.source.kind === "security"
          ? [publicTickerKey(series.source.instrument.symbol, series.source.instrument.exchange)]
          : []
      )))],
      rangePreset: spec.viewport.range,
      resolution: spec.viewport.resolution,
      baseSeries: spec.series.map((series) => ({
        id: series.id,
        sourceKind: series.source.kind,
        ...(series.source.kind === "security"
          ? {
            symbol: publicTickerKey(series.source.instrument.symbol, series.source.instrument.exchange),
            fieldId: series.source.fieldId,
          }
          : series.source.kind === "economic"
            ? { economicSeriesId: series.source.seriesId }
            : (() => {
                const resolvedSeries = payload.chartModel?.series.find((entry) => entry.id === series.id);
                return {
                  capabilityId: series.source.capabilityId,
                  providerSeriesId: series.source.seriesId,
                  first: capabilityPoint(resolvedSeries?.points[0]),
                  last: capabilityPoint(resolvedSeries?.points.at(-1)),
                };
              })()),
        style: series.style,
        transform: series.transform,
        panelId: series.panelId,
        visible: series.visible !== false,
      })),
    };
  }
  if (resolved.capability.id === "price-chart") {
    const range = String(resolved.options.rangePreset ?? "5Y") as TimeRange;
    const sourceSeries = payload.financials.slice(0, 1).map(([symbol, financials]) => {
      const { points } = normalizeChartSeries(symbol, financials, range);
      return chartSeriesEvidenceWithinRange(symbol, points, range);
    });
    return {
      kind: "stock-price",
      symbols: sourceSeries.map(({ symbol }) => symbol),
      rangePreset: range,
      axisMode: "price",
      sourceSeries,
    };
  }
  if (resolved.capability.id === "price-comparison") {
    const range = String(resolved.options.rangePreset ?? "1Y") as TimeRange;
    const normalizedSeries = payload.financials.map(([symbol, financials]) => (
      normalizeChartSeries(symbol, financials, range)
    ));
    const latestTimestamp = Math.max(
      ...normalizedSeries.flatMap(({ points }) => points.map(({ date }) => date.getTime())),
    );
    const projectionStart = Number.isFinite(latestTimestamp)
      ? subtractTimeRange(new Date(latestTimestamp), range).getTime()
      : Number.NaN;
    const axisMode = String(resolved.options.axisMode ?? "percent");
    const sourceSeries = normalizedSeries.map(({ evidence, points }) => {
      const projectionPoints = points.filter(({ date }) => date.getTime() >= projectionStart);
      const baseValue = projectionPoints[0]?.close ?? null;
      const latestRawValue = projectionPoints.at(-1)?.close ?? null;
      const latestValue = baseValue == null || latestRawValue == null
        ? null
        : axisMode === "percent"
          ? ((latestRawValue - baseValue) / baseValue) * 100
          : latestRawValue;
      return {
        ...evidence,
        projectionBaseValue: baseValue,
        projectionLatestRawValue: latestRawValue,
        projectionLatestValue: latestValue,
      };
    });
    return {
      kind: "price-comparison",
      symbols: sourceSeries.map(({ symbol }) => symbol),
      rangePreset: range,
      axisMode,
      resolution: String(resolved.options.chartResolution ?? "1d"),
      sourceSeries,
    };
  }
  return null;
}

function readStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : null;
}

function closeEnough(actual: unknown, expected: number): boolean {
  return typeof actual === "number"
    && Number.isFinite(actual)
    && Math.abs(actual - expected) <= Math.max(1e-8, Math.abs(expected) * 1e-8);
}

function pointEvidenceMatches(
  actual: unknown,
  expected: PaneScreenshotChartPointEvidence | null,
): boolean {
  if (expected === null) return actual === null;
  return isRecord(actual)
    && actual.date === expected.date
    && closeEnough(actual.close, expected.close);
}

function sourceSeriesMismatches(
  actual: unknown,
  expected: PaneScreenshotChartSeriesEvidence[],
): string[] {
  if (!Array.isArray(actual)) return ["chart source-series evidence is missing"];
  if (actual.length !== expected.length) return ["chart source-series count does not match"];
  const mismatches: string[] = [];
  expected.forEach((expectedSeries, index) => {
    const actualSeries = actual[index];
    if (!isRecord(actualSeries) || actualSeries.symbol !== expectedSeries.symbol) {
      mismatches.push(`chart source symbol ${index + 1} does not match`);
      return;
    }
    if (actualSeries.pointCount !== expectedSeries.pointCount) {
      mismatches.push(`${expectedSeries.symbol} chart source point count does not match`);
    }
    if (!pointEvidenceMatches(actualSeries.first, expectedSeries.first)) {
      mismatches.push(`${expectedSeries.symbol} chart source first value does not match`);
    }
    if (!pointEvidenceMatches(actualSeries.last, expectedSeries.last)) {
      mismatches.push(`${expectedSeries.symbol} chart source last value does not match`);
    }
  });
  return mismatches;
}

export function chartEvidenceMismatchesFor(
  semanticUi: RemoteUiNodeSnapshot[],
  expected: PaneScreenshotExpectedChartEvidence,
): string[] {
  const node = semanticUi.find((candidate) => (
    candidate.role === "chart-data"
    && candidate.metadata?.kind === expected.kind
  ));
  const metadata = node?.metadata;
  if (!metadata) return ["rendered chart-data semantic evidence is missing"];

  const mismatches: string[] = [];
  const symbols = readStringArray(metadata.symbols);
  if (!symbols || symbols.join("\0") !== expected.symbols.join("\0")) {
    mismatches.push("rendered chart symbols do not match");
  }
  if (metadata.rangePreset !== expected.rangePreset) {
    mismatches.push("rendered chart range does not match");
  }

  if (expected.kind === "chart-composer") {
    if (expected.resolution != null && metadata.resolution !== expected.resolution) {
      mismatches.push("rendered chart resolution does not match");
    }
    const actualSeries = Array.isArray(metadata.baseSeries) ? metadata.baseSeries : [];
    const expectedSeries = expected.baseSeries ?? [];
    if (actualSeries.length !== expectedSeries.length) {
      mismatches.push("rendered chart base-series count does not match");
    } else {
      expectedSeries.forEach((series, index) => {
        const actual = actualSeries[index];
        if (!isRecord(actual)
          || actual.id !== series.id
          || actual.sourceKind !== series.sourceKind
          || actual.symbol !== series.symbol
          || actual.fieldId !== series.fieldId
          || actual.economicSeriesId !== series.economicSeriesId
          || actual.capabilityId !== series.capabilityId
          || actual.providerSeriesId !== series.providerSeriesId
          || (series.sourceKind === "capability" && (
            JSON.stringify(actual.first) !== JSON.stringify(series.first)
            || JSON.stringify(actual.last) !== JSON.stringify(series.last)
          ))
          || actual.style !== series.style
          || actual.transform !== series.transform
          || actual.panelId !== series.panelId
          || actual.visible !== series.visible) {
          mismatches.push(`rendered chart series ${series.id} does not match`);
          return;
        }
        if (series.visible && (typeof actual.pointCount !== "number" || actual.pointCount <= 0)) {
          mismatches.push(`rendered chart series ${series.id} is empty`);
        }
      });
    }
    if (typeof metadata.projectedPointCount !== "number" || metadata.projectedPointCount <= 0) {
      mismatches.push("rendered chart projection is empty");
    }
    return mismatches;
  }

  if (expected.kind === "stock-price") {
    if (metadata.axisMode !== expected.axisMode) {
      mismatches.push("rendered chart axis mode does not match");
    }
    const expectedSeries = expected.sourceSeries?.[0];
    if (!expectedSeries) return [...mismatches, "expected stock chart source evidence is missing"];
    mismatches.push(...sourceSeriesMismatches([{
      symbol: symbols?.[0],
      pointCount: metadata.sourcePointCount,
      first: metadata.sourceFirst,
      last: metadata.sourceLast,
    }], expected.sourceSeries ?? []));
    if (typeof metadata.projectedPointCount !== "number" || metadata.projectedPointCount <= 0) {
      mismatches.push("rendered stock chart projection is empty");
    }
    return mismatches;
  }

  if (metadata.requestedAxisMode !== expected.axisMode || metadata.effectiveAxisMode !== expected.axisMode) {
    mismatches.push("rendered comparison axis mode does not match");
  }
  if (
    expected.resolution != null
    && (
      metadata.selectedResolution !== expected.resolution
      || metadata.effectiveResolution !== expected.resolution
    )
  ) {
    mismatches.push("rendered comparison resolution does not match");
  }
  const expectedSourceSeries = expected.sourceSeries ?? [];
  mismatches.push(...sourceSeriesMismatches(metadata.sourceSeries, expectedSourceSeries));

  const projectionSeries = Array.isArray(metadata.projectionSeries)
    ? metadata.projectionSeries
    : [];
  if (projectionSeries.length !== expectedSourceSeries.length) {
    mismatches.push("rendered comparison projection-series count does not match");
  } else {
    expectedSourceSeries.forEach((expectedSeries, index) => {
      const actualSeries = projectionSeries[index];
      if (!isRecord(actualSeries) || actualSeries.symbol !== expectedSeries.symbol) {
        mismatches.push(`${expectedSeries.symbol} comparison projection is missing`);
        return;
      }
      const baseValue = expectedSeries.projectionBaseValue;
      const latestRawValue = expectedSeries.projectionLatestRawValue;
      if (baseValue == null || latestRawValue == null) {
        mismatches.push(`${expectedSeries.symbol} expected comparison values are empty`);
        return;
      }
      const latestValue = expectedSeries.projectionLatestValue;
      if (!closeEnough(actualSeries.baseValue, baseValue)) {
        mismatches.push(`${expectedSeries.symbol} comparison base value does not match`);
      }
      if (!closeEnough(actualSeries.latestRawValue, latestRawValue)) {
        mismatches.push(`${expectedSeries.symbol} comparison latest value does not match`);
      }
      if (latestValue == null || !closeEnough(actualSeries.latestValue, latestValue)) {
        mismatches.push(`${expectedSeries.symbol} comparison transformed value does not match`);
      }
      if (actualSeries.pointCount !== metadata.projectedPointCount) {
        mismatches.push(`${expectedSeries.symbol} comparison projection point count does not match`);
      }
    });
  }
  if (typeof metadata.projectedPointCount !== "number" || metadata.projectedPointCount <= 0) {
    mismatches.push("rendered comparison projection is empty");
  }
  return mismatches;
}

export function intradayChartEvidenceMismatchesFor(
  resolved: ResolvedPaneFunction,
  payload: DesktopPaneShotPayload,
  semanticUi: RemoteUiNodeSnapshot[],
): string[] {
  if (resolved.capability.id !== "intraday-price-chart") return [];
  const intraday = payload.intradayHistories[0];
  if (!intraday || intraday.points.length === 0) return [];
  const metadata = semanticUi.find((node) => (
    node.role === "chart-data" && node.metadata?.kind === "chart-composer"
  ))?.metadata;
  if (!metadata) return ["rendered intraday chart-data semantic evidence is missing"];
  const baseSeries = Array.isArray(metadata.baseSeries) ? metadata.baseSeries : [];
  const actual = baseSeries[0];
  if (!isRecord(actual)) return ["rendered intraday base series is missing"];

  const expected = chartSeriesEvidence(intraday.symbol, intraday.points);
  const mismatches: string[] = [];
  if (actual.pointCount !== expected.pointCount) {
    mismatches.push("rendered intraday point count does not match");
  }
  if (metadata.projectedPointCount !== expected.pointCount) {
    mismatches.push("rendered intraday projection point count does not match");
  }
  const pointMatches = (
    actualPoint: unknown,
    expectedPoint: PaneScreenshotChartPointEvidence | null,
  ): boolean => {
    if (!isRecord(actualPoint) || !expectedPoint) return false;
    return actualPoint.date === expectedPoint.date
      && typeof actualPoint.value === "number"
      && closeEnough(actualPoint.value, expectedPoint.close);
  };
  if (!pointMatches(actual.first, expected.first)) {
    mismatches.push("rendered intraday first bar does not match");
  }
  if (!pointMatches(actual.last, expected.last)) {
    mismatches.push("rendered intraday last bar does not match");
  }
  return mismatches;
}
