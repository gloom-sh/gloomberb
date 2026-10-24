import { CHART_COMPOSER_PANE_ID } from "../../types/config";
import { isRecord } from "../../utils/guards";
import type { DesktopPaneShotPayload } from "../desktop-pane-shot";
import type { ResolvedPaneFunction } from "./resolver";
import type { RemoteUiNodeSnapshot } from "../../remote/types";
import { graphRowsForFinancials, limitGraphRowsBySymbol, metricDef } from "../../time-series/reporting";
import { getTimeSeriesField } from "../../time-series/field-catalog";
import {
  buildFinancialTableModel,
  financialStatementCurrency,
  formatFinancialHeader,
} from "../../plugins/builtin/ticker-detail/financials/model";
import type { FundamentalPeriod, GraphKind, GraphMetricKey } from "../../time-series/reporting";
import type { TimeRange } from "../../time-series/range";
import { subtractTimeRange } from "../../time-series/date-window";
import { parseChartSpec } from "../../plugins/builtin/chart-composer/chart-spec";
import { publicTickerKey } from "../../utils/exchanges";
import { paneScreenshotEvidenceHook, renderedPaneEvidence } from "./screenshot-evidence";
import { financialRatioShotEvidence, shotRatioTab } from "./financial-ratio-shot";
import type { PaneScreenshotDataEvidence } from "./screenshot-types";
import { normalizeChartSeries, chartSeriesEvidence } from "./screenshot-chart-evidence";

const STATEMENT_EVIDENCE_KEYS: Record<string, ReadonlySet<string>> = {
  income: new Set([
    "totalRevenue",
    "grossProfit",
    "operatingIncome",
    "netIncome",
    "netIncomeCommonStockholders",
    "eps",
    "basicEps",
  ]),
  cashflow: new Set([
    "operatingCashFlow",
    "capitalExpenditure",
    "freeCashFlow",
  ]),
  balance: new Set([
    "totalAssets",
    "totalLiabilities",
    "cashAndCashEquivalents",
    "totalDebt",
    "totalEquity",
    "commonStockEquity",
  ]),
};

export function shotDataEvidenceFor(
  resolved: ResolvedPaneFunction,
  payload: DesktopPaneShotPayload,
  semanticUi: RemoteUiNodeSnapshot[] = [],
): PaneScreenshotDataEvidence | null {
  const evidenceHook = paneScreenshotEvidenceHook(resolved);
  if (evidenceHook) return renderedPaneEvidence(evidenceHook, semanticUi);
  const spec = payload.chartModel ? parseChartSpec(payload.config.layout.instances.find((instance) => instance.instanceId === payload.paneId)?.settings?.chartSpec) : null;
  const visibleSeries = payload.chartModel && spec ? spec.series.flatMap((entry) => {
    if (entry.source.kind !== "security" || entry.visible === false) return [];
    const output = payload.chartModel!.series.find((series) => series.id === entry.id);
    return [{
      symbol: publicTickerKey(entry.source.instrument.symbol, entry.source.instrument.exchange),
      points: (output?.points ?? []).flatMap((point) => {
        const close = point.rawValue === undefined ? point.value ?? point.close : point.rawValue;
        return typeof close === "number" && Number.isFinite(close) ? [{ date: point.date, close }] : [];
      }),
    }];
  }) : null;
  if (resolved.capability.id === "intraday-price-chart") {
    const intraday = payload.intradayHistories[0];
    if (!intraday || intraday.points.length === 0) return null;
    const evidence = chartSeriesEvidence(intraday.symbol, intraday.points);
    if (!evidence.first || !evidence.last) return null;
    return {
      kind: "price-series",
      symbol: intraday.symbol,
      range: intraday.rangePreset,
      pointCount: evidence.pointCount,
      first: evidence.first,
      last: evidence.last,
      resolution: intraday.resolution,
      sessionDates: intraday.sessionDates,
    };
  }

  if (resolved.capability.id === "price-chart") {
    const range = String(resolved.options.rangePreset ?? "5Y") as TimeRange;
    const [symbol, financials] = payload.financials[0] ?? [];
    const captured = visibleSeries?.[0];
    const evidence = captured ? chartSeriesEvidence(captured.symbol, captured.points)
      : visibleSeries === null && symbol && financials ? normalizeChartSeries(symbol, financials, range).evidence : null;
    if (!evidence?.first || !evidence.last || evidence.pointCount <= 0) return null;
    return { kind: "price-series", range, ...evidence, first: evidence.first, last: evidence.last };
  }

  if (resolved.capability.id === "price-comparison") {
    const range = String(resolved.options.rangePreset ?? "1Y") as TimeRange;
    const normalizedSeries = visibleSeries ?? payload.financials.map(([symbol, financials]) => ({
      symbol,
      points: normalizeChartSeries(symbol, financials, range).points,
    }));
    const latestTimestamp = Math.max(
      ...normalizedSeries.flatMap(({ points }) => points.map(({ date }) => date.getTime())),
    );
    if (!Number.isFinite(latestTimestamp)) return null;
    const projectionStart = subtractTimeRange(new Date(latestTimestamp), range).getTime();
    const series = normalizedSeries.flatMap(({ symbol, points }) => {
      const projectionPoints = visibleSeries ? points : points.filter(({ date }) => date.getTime() >= projectionStart);
      const base = projectionPoints[0];
      const latest = projectionPoints.at(-1);
      if (!base || !latest || !Number.isFinite(base.close) || !Number.isFinite(latest.close) || base.close === 0) {
        return [];
      }
      return [{
        symbol,
        base: { date: base.date.toISOString(), value: base.close },
        latest: { date: latest.date.toISOString(), value: latest.close },
        returnPercent: ((latest.close - base.close) / base.close) * 100,
      }];
    });
    if (series.length !== normalizedSeries.length) return null;
    return {
      kind: "price-comparison",
      symbols: series.map(({ symbol }) => symbol),
      range,
      series,
    };
  }

  if (resolved.capability.id === "fundamental-series") {
    const metric = resolved.options.metric as GraphMetricKey;
    const period = resolved.options.period as FundamentalPeriod;
    const periodCount = resolved.options.periods == null ? null : Number(resolved.options.periods);
    const evidencePeriodCount = Math.min(
      periodCount ?? (period === "annual" ? 6 : 8),
      period === "annual" ? 6 : 8,
    );
    const series = visibleSeries?.map(({ symbol, points }) => ({
      symbol, rows: points.slice(-evidencePeriodCount).map(({ date, close }) => ({ date: date.toISOString().slice(0, 10), value: close })),
    })) ?? payload.financials.map(([symbol, financials]) => ({
      symbol,
      rows: limitGraphRowsBySymbol(
        graphRowsForFinancials(financials, "fundamental", metric, period, symbol),
        evidencePeriodCount,
      )
        .sort((left, right) => left.date.localeCompare(right.date))
        .map(({ date, value }) => ({ date, value })),
    }));
    if (series.some(({ rows }) => rows.length === 0)) return null;
    return { kind: "fundamental-series", metric, period, series };
  }

  if (shotRatioTab(resolved)) return financialRatioShotEvidence(resolved, payload);
  if (resolved.capability.id === "financial-statements") {
    const [symbol, financials] = payload.financials[0] ?? [];
    if (!symbol || !financials) return null;
    const table = buildFinancialTableModel(financials, {
      period: resolved.options.period as FundamentalPeriod,
      statement: String(resolved.options.statement),
    });
    if (!table || table.statements.length === 0) return null;
    const allowedKeys = STATEMENT_EVIDENCE_KEYS[table.subTab.key] ?? new Set<string>();
    const latestPopulated = table.statements.flatMap((statement, statementIndex) => {
      const seenKeys = new Set<string>();
      const metrics = table.rows.flatMap((row) => {
        const key = String(row.key ?? row.summaryKey ?? "");
        const value = row.cells[statementIndex]?.value;
        if (!allowedKeys.has(key) || seenKeys.has(key) || typeof value !== "number" || !Number.isFinite(value)) {
          return [];
        }
        seenKeys.add(key);
        return [{
          id: row.id,
          key,
          label: row.unitLabel,
          value,
        }];
      });
      return metrics.length > 0 ? [{ statement, metrics }] : [];
    })[0];
    if (!latestPopulated) return null;
    return {
      kind: "financial-statement",
      symbol,
      statement: table.subTab.key,
      period: table.period,
      latest: {
        date: latestPopulated.statement.date,
        metrics: latestPopulated.metrics,
      },
    };
  }

  return null;
}

export function shotUnavailableSymbols(
  resolved: ResolvedPaneFunction,
  payload: DesktopPaneShotPayload,
  semanticUi: RemoteUiNodeSnapshot[] = [],
): string[] {
  const evidenceHook = paneScreenshotEvidenceHook(resolved);
  if (evidenceHook) return evidenceHook.unavailable(renderedPaneEvidence(evidenceHook, semanticUi), { resolved, payload });
  if (resolved.capability.id === "chart-composer") {
    const metadata = semanticUi.find((node) => (
      node.role === "chart-data" && node.metadata?.kind === "chart-composer"
    ))?.metadata;
    const baseSeries = Array.isArray(metadata?.baseSeries) ? metadata.baseSeries : [];
    return baseSeries.flatMap((entry) => {
      if (!isRecord(entry) || (typeof entry.pointCount === "number" && entry.pointCount > 0)) return [];
      if (entry.sourceKind === "security" && typeof entry.symbol === "string") return [entry.symbol];
      if (entry.sourceKind === "economic" && typeof entry.economicSeriesId === "string") {
        return [`FRED:${entry.economicSeriesId}`];
      }
      if (entry.sourceKind === "capability" && typeof entry.capabilityId === "string" && typeof entry.providerSeriesId === "string") {
        return [`CAP:${entry.capabilityId}:${entry.providerSeriesId}`];
      }
      return [];
    });
  }
  if (resolved.capability.id === "intraday-price-chart") {
    const symbol = payload.intradayHistories[0]?.symbol ?? payload.financials[0]?.[0];
    const metadata = semanticUi.find((node) => (
      node.role === "chart-data" && node.metadata?.kind === "chart-composer"
    ))?.metadata;
    const renderedPoints = typeof metadata?.projectedPointCount === "number"
      ? metadata.projectedPointCount
      : 0;
    return symbol && renderedPoints <= 0 ? [symbol] : [];
  }
  const graphKind = shotGraphKind(resolved);
  if (graphKind) {
    const metric = resolved.options.metric as GraphMetricKey;
    const period = resolved.options.period as FundamentalPeriod;
    const periodCount = resolved.options.periods == null ? null : Number(resolved.options.periods);
    return payload.financials.flatMap(([symbol, financials]) => (
      limitGraphRowsBySymbol(
        graphRowsForFinancials(financials, graphKind, metric, period, symbol),
        periodCount,
      ).length === 0 ? [symbol] : []
    ));
  }
  if (["price-chart", "historical-prices"].includes(resolved.capability.id)) {
    return payload.financials.flatMap(([symbol, financials]) => financials.priceHistory.length > 0 ? [] : [symbol]);
  }
  if (["price-comparison", "return-correlation", "security-relationship"].includes(resolved.capability.id)) {
    return payload.financials.flatMap(([symbol, financials]) => financials.priceHistory.length > 1 ? [] : [symbol]);
  }
  if (resolved.capability.id === "financial-statements") {
    return payload.financials.flatMap(([symbol, financials]) => {
      const count = resolved.options.period === "quarterly"
        ? financials.quarterlyStatements.length
        : financials.annualStatements.length;
      return count > 0 ? [] : [symbol];
    });
  }
  return payload.financials.flatMap(([symbol, financials]) => financials.quote ? [] : [symbol]);
}

export function shotGraphKind(resolved: ResolvedPaneFunction): GraphKind | null {
  if (resolved.capability.id === "fundamental-series") return "fundamental";
  if (resolved.capability.id === "valuation-series") return "valuation";
  return null;
}

export function shotSemanticRowCount(
  resolved: ResolvedPaneFunction,
  payload: DesktopPaneShotPayload,
  semanticUi: RemoteUiNodeSnapshot[] = [],
): number {
  const evidenceHook = paneScreenshotEvidenceHook(resolved);
  if (evidenceHook) return renderedPaneEvidence(evidenceHook, semanticUi)?.plottedValueCount ?? 0;
  if (resolved.capability.id === "chart-composer") {
    const metadata = semanticUi.find((node) => (
      node.role === "chart-data" && node.metadata?.kind === "chart-composer"
    ))?.metadata;
    const baseSeries = Array.isArray(metadata?.baseSeries) ? metadata.baseSeries : [];
    return baseSeries.reduce((count, entry) => (
      count + (isRecord(entry) && typeof entry.pointCount === "number" ? Math.max(0, entry.pointCount) : 0)
    ), 0);
  }
  if (resolved.capability.id === "intraday-price-chart") {
    const metadata = semanticUi.find((node) => (
      node.role === "chart-data" && node.metadata?.kind === "chart-composer"
    ))?.metadata;
    return typeof metadata?.projectedPointCount === "number"
      ? Math.max(0, metadata.projectedPointCount)
      : 0;
  }
  const graphKind = shotGraphKind(resolved);
  if (graphKind) {
    const metric = resolved.options.metric as GraphMetricKey;
    const period = resolved.options.period as FundamentalPeriod;
    const periodCount = resolved.options.periods == null ? null : Number(resolved.options.periods);
    return payload.financials.reduce((count, [symbol, financials]) => (
      count + limitGraphRowsBySymbol(
        graphRowsForFinancials(financials, graphKind, metric, period, symbol),
        periodCount,
      ).length
    ), 0);
  }
  if (["price-chart", "historical-prices"].includes(resolved.capability.id)) {
    return payload.financials[0]?.[1].priceHistory.length ?? 0;
  }
  if (["price-comparison", "return-correlation", "security-relationship"].includes(resolved.capability.id)) {
    return payload.financials.filter(([, financials]) => financials.priceHistory.length > 1).length;
  }
  if (resolved.capability.id === "financial-statements") {
    const financials = payload.financials[0]?.[1];
    const period = resolved.options.period;
    return period === "quarterly"
      ? financials?.quarterlyStatements.length ?? 0
      : financials?.annualStatements.length ?? 0;
  }
  return payload.financials.filter(([, financials]) => !!financials.quote).length;
}

export function shotExpectedText(
  resolved: ResolvedPaneFunction,
  symbols: string[],
  payload: DesktopPaneShotPayload,
): string[] {
  const expected = [...symbols, ...(paneScreenshotEvidenceHook(resolved)?.expectedText?.({ resolved, payload }) ?? [])];
  const graphKind = shotGraphKind(resolved);
  if (graphKind) {
    const metric = resolved.options.metric as GraphMetricKey;
    const definition = metricDef(graphKind, metric);
    const period = resolved.options.period as FundamentalPeriod;
    const periodCount = resolved.options.periods == null ? null : Number(resolved.options.periods);
    if (resolved.pane.id === CHART_COMPOSER_PANE_ID) {
      // Chart series are labelled with the field short label ("P/S"), not the
      // catalog label ("Price / Sales").
      const field = getTimeSeriesField(`${graphKind}.${metric}`);
      expected.push(field?.shortLabel ?? definition.label);
      return expected.filter(Boolean);
    }
    expected.push(definition.label);
    for (const [symbol, financials] of payload.financials) {
      const latestRow = limitGraphRowsBySymbol(
        graphRowsForFinancials(financials, graphKind, metric, period, symbol),
        periodCount,
      ).sort((left, right) => left.date.localeCompare(right.date)).at(-1);
      if (latestRow) {
        expected.push(latestRow.date);
        expected.push(definition.format(latestRow.value));
      }
    }
  } else if (resolved.capability.id === "financial-statements") {
    const statementLabels: Record<string, string> = {
      income: "Income",
      balance: "Balance",
      cashflow: "Cash Flow",
    };
    // A ratio tab names itself in the query bar and leads with its first ratio.
    const ratioTab = shotRatioTab(resolved);
    expected.push(ratioTab?.name ?? statementLabels[String(resolved.options.statement)] ?? "");
    expected.push(resolved.options.period === "annual" ? "Annual" : "Quarterly");
    const financials = payload.financials[0]?.[1];
    if (financials) {
      const table = buildFinancialTableModel(financials, {
        period: resolved.options.period as FundamentalPeriod,
        statement: String(resolved.options.statement),
      });
      const latestStatement = table?.statements[0];
      const firstMetric = table?.rows[0];
      // The pane prints the compact header: date, currency and an S/P source marker.
      if (latestStatement) {
        const currency = latestStatement.currency ?? financialStatementCurrency(
          financials,
          [...(financials.annualStatements ?? []), ...(financials.quarterlyStatements ?? [])],
        );
        expected.push(formatFinancialHeader(
          latestStatement.date,
          currency,
          latestStatement.dateSource,
          true,
          latestStatement.aggregation?.periodEnd,
        ).trim());
      }
      const firstLabel = ratioTab ? ratioTab.ratios[0]?.label : firstMetric?.unitLabel;
      if (firstLabel) expected.push(firstLabel);
    }
  }
  return expected.filter(Boolean);
}
