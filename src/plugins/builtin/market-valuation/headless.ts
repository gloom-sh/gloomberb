import type {
  HeadlessBundleResult,
  HeadlessPaneDefinition,
  HeadlessPaneEntry,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import { formatNumber } from "../../../utils/format";
import {
  createValuationSeriesLoader,
  loadValuationBundle,
  type ValuationSeriesLoader,
} from "./client";
import type { ValuationRangeId } from "./defs";
import { DEFAULT_INDICATOR_ID, INDICATORS, resolveIndicatorArg } from "./indicators";
import { createCloudSourceDeps } from "./sources";
import {
  formatSigma,
  selectValuationViews,
  type IndicatorViewModel,
  type ValuationBundle,
} from "./view";

function detailEntries(view: IndicatorViewModel): HeadlessPaneEntry[] {
  const format = view.indicator.formatValue;
  return [
    { label: "Current", value: view.current.ratio, formatted: format(view.current.ratio) },
    {
      label: "1Y ago",
      value: view.ratioOneYearAgo,
      formatted: view.ratioOneYearAgo == null ? "-" : format(view.ratioOneYearAgo),
    },
    { label: "Mean", value: view.mean, formatted: format(view.mean) },
    {
      label: "Rich percentile",
      value: view.richPercentile,
      formatted: formatNumber(view.richPercentile, 0),
    },
    {
      label: "Trend deviation",
      value: view.richSigma,
      formatted: formatSigma(view.richSigma),
    },
    {
      label: "All-time high",
      value: { value: view.allTimeHigh.ratio, date: view.allTimeHigh.date },
      formatted: `${format(view.allTimeHigh.ratio)} ${view.allTimeHigh.date}`,
    },
    {
      label: "All-time low",
      value: { value: view.allTimeLow.ratio, date: view.allTimeLow.date },
      formatted: `${format(view.allTimeLow.ratio)} ${view.allTimeLow.date}`,
    },
    { label: "As of", value: view.asOf },
  ];
}

export function projectValuationHeadlessBundle(
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
    formattedValue: view.indicator.formatValue(view.current.ratio),
    zone: view.zone.label,
    richPercentile: view.richPercentile,
    richSigma: view.richSigma,
    asOf: view.asOf,
    stale: view.observationStale,
  }));

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
            format: (value) => formatNumber(Number(value), 0),
          },
          {
            key: "richSigma",
            header: "Trend",
            align: "right",
            format: (value) => formatSigma(Number(value)),
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
      range,
      selected: selected?.indicator.id ?? null,
    },
  };
}

export interface MarketValuationHeadlessDependencies {
  loadBundle(args: HeadlessPaneLoadArgs, loader: ValuationSeriesLoader): Promise<ValuationBundle>;
}

const defaultDependencies: MarketValuationHeadlessDependencies = {
  loadBundle: (args, loader) => {
    const requested = typeof args.argument === "string" ? resolveIndicatorArg(args.argument) : null;
    return loadValuationBundle({
      loader,
      ...(requested ? { indicators: [requested] } : {}),
    });
  },
};

export function createMarketValuationHeadless(
  dependencies: MarketValuationHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"bundle"> {
  return {
    shape: "bundle",
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
    describe: (args) => `Market Valuation | ${String(args.options.range)}`,
    async load(args, ctx) {
      const requested = typeof args.argument === "string" ? resolveIndicatorArg(args.argument) : null;
      if (args.argument && !requested) {
        throw new Error(
          `Unknown valuation indicator "${String(args.argument)}". Use one of: ${INDICATORS.map(({ id }) => id).join(", ")}.`,
        );
      }
      const range = args.options.range as ValuationRangeId;
      const loader = createValuationSeriesLoader(createCloudSourceDeps(ctx.apiClient));
      const bundle = await dependencies.loadBundle(args, loader);
      return projectValuationHeadlessBundle(
        bundle,
        range,
        requested?.id ?? DEFAULT_INDICATOR_ID,
      );
    },
  };
}

export const marketValuationHeadless = createMarketValuationHeadless();
