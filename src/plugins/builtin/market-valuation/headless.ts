import type {
  HeadlessBundleResult,
  HeadlessPaneDefinition,
  HeadlessPaneEntry,
} from "../../../types/plugin";
import { formatNumber } from "../../../utils/format";
import {
  createValuationSeriesLoader,
  loadValuationBundle,
} from "./client";
import type { ValuationRangeId } from "./defs";
import { DEFAULT_INDICATOR_ID, INDICATORS, resolveIndicatorArg } from "./indicators";
import { createCloudSourceDeps } from "./sources";
import { historyStartNotice, sinceLabel } from "../shared/history-span";
import { formatSigma } from "../shared/trend";
import {
  selectValuationViews,
  type IndicatorViewModel,
  type ValuationBundle,
} from "./view";

function detailEntries(view: IndicatorViewModel): HeadlessPaneEntry[] {
  const format = view.indicator.formatValue;
  return [
    { label: "Current", value: view.current.ratio, formatted: view.current.ratio == null ? "--" : format(view.current.ratio) },
    { label: "Basis", value: view.indicator.description },
    { label: "Unit", value: view.indicator.axisUnit || "x" },
    {
      label: "1Y ago",
      value: view.ratioOneYearAgo,
      formatted: view.ratioOneYearAgo == null ? "-" : format(view.ratioOneYearAgo),
    },
    // Taken over the whole history whatever the range, and labelled so.
    { label: sinceLabel("Mean", view.historyStart), value: view.mean, formatted: format(view.mean) },
    {
      label: sinceLabel("Rich percentile", view.historyStart),
      value: view.richPercentile,
      formatted: view.richPercentile == null ? "--" : formatNumber(view.richPercentile, 0),
    },
    {
      label: "Trend deviation",
      value: view.richSigma,
      formatted: formatSigma(view.richSigma),
    },
    {
      label: sinceLabel("High", view.historyStart),
      value: { value: view.allTimeHigh.ratio, date: view.allTimeHigh.date },
      formatted: `${format(view.allTimeHigh.ratio)} ${view.allTimeHigh.date}`,
    },
    {
      label: sinceLabel("Low", view.historyStart),
      value: { value: view.allTimeLow.ratio, date: view.allTimeLow.date },
      formatted: `${format(view.allTimeLow.ratio)} ${view.allTimeLow.date}`,
    },
    { label: "As of", value: view.asOf },
  ];
}

function projectValuationHeadlessBundle(
  bundle: ValuationBundle,
  range: ValuationRangeId,
  selectedId: string,
): HeadlessBundleResult {
  const views = selectValuationViews(bundle, range);
  const selected = views.find((view) => view.indicator.id === selectedId) ?? views[0] ?? null;
  const rows = views.map((view) => ({
    id: view.indicator.id,
    indicator: view.indicator.label,
    value: view.current.ratio,
    formattedValue: view.current.ratio == null ? "--" : view.indicator.formatValue(view.current.ratio),
    basis: view.indicator.description,
    unit: view.indicator.axisUnit || "x",
    zone: view.zone?.label ?? "Unavailable",
    richPercentile: view.richPercentile,
    richSigma: view.richSigma,
    historyStart: view.historyStart,
    asOf: view.asOf,
    stale: view.observationStale,
  }));

  const notice = selected ? historyStartNotice(selected.indicator.label, range, selected.span) : null;
  return {
    sections: [
      {
        title: "Market valuation",
        columns: [
          { key: "indicator", header: "Indicator" },
          {
            key: "value",
            header: "Value",
            align: "right",
            format: (_value, row) => String(row.formattedValue),
          },
          { key: "zone", header: "Zone" },
          {
            key: "richPercentile",
            header: "Rich %ile",
            align: "right",
            format: (value) => value == null ? "--" : formatNumber(Number(value), 0),
          },
          {
            // Where the indicator's history starts: its percentile and trend are taken from there whatever the range.
            key: "historyStart",
            header: "Since",
            align: "right",
            format: (value) => typeof value === "string" ? value.slice(0, 4) : "--",
          },
          {
            key: "richSigma",
            header: "Trend",
            align: "right",
            format: (value) => formatSigma(value == null ? null : Number(value)),
          },
          { key: "asOf", header: "As of" },
        ],
        rows,
      },
      ...(selected
        ? [{ title: selected.indicator.label, entries: detailEntries(selected) }]
        : []),
    ],
    errors: bundle.errors,
    metadata: {
      fetchedAt: bundle.fetchedAt,
      sources: bundle.sources,
      range,
      selected: selected?.indicator.id ?? null,
      ...(notice ? { notices: [notice] } : {}),
    },
  };
}

export const marketValuationHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  // Each indicator row checks its own release schedule and says when it is stale.
  freshness: { status: "not-a-feed", basis: "published statistics" },
  argument: {
    kind: "free-text",
    placeholder: "indicator",
    description: "Optional valuation indicator id, label, or prefix.",
    optional: true,
  },
  options: [{
    key: "range",
    description: "History window used by the selected indicator view.",
    type: "enum",
    values: [{ value: "10Y" }, { value: "25Y" }, { value: "ALL", aliases: ["all"] }],
    defaultValue: "25Y",
  }],
  // The range asked for: the table lists every indicator, each with a history of its own.
  describe: (args) => `Market Valuation | ${String(args.options.range)}`,
  async load(args, ctx) {
    const requested = typeof args.argument === "string" ? resolveIndicatorArg(args.argument) : null;
    if (args.argument && !requested) {
      throw new Error(
        `Unknown valuation indicator "${String(args.argument)}". Use one of: ${INDICATORS.map(({ id }) => id).join(", ")}.`,
      );
    }
    const range = args.options.range as ValuationRangeId;
    const bundle = await loadValuationBundle({
      loader: createValuationSeriesLoader(createCloudSourceDeps(ctx.apiClient)),
      ...(requested ? { indicators: [requested] } : {}),
    });
    return projectValuationHeadlessBundle(
      bundle,
      range,
      requested?.id ?? DEFAULT_INDICATOR_ID,
    );
  },
};
