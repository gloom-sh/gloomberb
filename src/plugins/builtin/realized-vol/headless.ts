import { barsPerYearLabel } from "../../../market-data/bars-per-year";
import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { createSurfaceDependencies } from "../vol-surface/client";
import { resolveHeadlessInstrument } from "../shared/headless-market-data";
import { createRealizedVolatilityDependencies, loadCurrentAtmIv, loadRealizedVolatilityHistory } from "./client";
import { atmIvObservedLabel, projectRealizedVolatility, type CurrentAtmIvSnapshot } from "./model";
import { ESTIMATOR_OPTIONS, selectedWindows } from "./settings";
import { DAILY_CLOSES } from "../shared/report-freshness";
import { listingAbroadVenue } from "../../../utils/sec";

export function realizedVolHeadless(initialView: "graph" | "cone"): HeadlessPaneDefinition<"bundle"> {
  return {
    shape: "bundle", argument: { kind: "ticker", description: "Underlying ticker" },
    freshness: { ...DAILY_CLOSES, observedKey: "date", oldest: null },
    describe: (args) => `${initialView === "graph" ? "HVG" : "HVT"} ${args.symbols[0] ?? ""}`,
    discovery: { screenshotReadiness: "live-dom", limitations: ["IV is a dated current observation; HIVG has the stored IV history."] },
    options: [
      { key: "tab", type: "enum", values: [{ value: "graph" }, { value: "cone" }], defaultValue: initialView,
        description: "Initial view", pluginState: { pluginId: "ticker-research", key: "activeTabId" } },
      { key: "estimator", type: "enum", values: ESTIMATOR_OPTIONS.map(({ value }) => ({ value })), defaultValue: "close-to-close", description: "Realized volatility estimator" },
      { key: "windows", type: "string", defaultValue: "10,30,90", description: "Comma-separated bar windows: 10,20,30,60,90,180,260" },
      { key: "lookbackYears", type: "integer", minimum: 1, maximum: 2, defaultValue: 1, description: "Historical lookback in calendar years" },
      { key: "showIv", type: "boolean", defaultValue: true, description: "Include a dated current ATM IV observation" },
    ],
    async load(args, ctx) {
      const windows = selectedWindows(args.options.windows);
      if (!windows.length || String(args.options.windows).split(",").some((value) => !windows.includes(Number(value)))) {
        throw new Error("Choose bar windows from 10,20,30,60,90,180,260");
      }
      const instrument = await resolveHeadlessInstrument(ctx, args.symbols[0]!);
      // Options are US listings'; SAN:EPA has none, and bare SAN's chain is another company's.
      const abroad = listingAbroadVenue(args.symbols[0]!) != null;
      const currentIv = async (): Promise<CurrentAtmIvSnapshot | null> => {
        if (!args.options.showIv) return null;
        if (abroad) return { reference: null, error: null, warnings: [], noOptionChain: true };
        try {
          const quote = await ctx.marketData.getQuote(instrument.symbol, instrument.exchange);
          if (quote.stale || !(quote.price > 0) || !Number.isFinite(quote.price)) throw new Error("Underlying quote is missing or stale");
          return await loadCurrentAtmIv({ instrument, spot: quote.price, spotAsOf: quote.lastUpdated, signal: ctx.signal },
            createSurfaceDependencies(ctx.marketData, ctx.apiClient));
        } catch (error) {
          ctx.signal.throwIfAborted();
          return { reference: null, warnings: [], error: `Current ATM IV: ${error instanceof Error ? error.message : String(error)}` };
        }
      };
      const [history, iv] = await Promise.all([
        loadRealizedVolatilityHistory({ instrument, signal: ctx.signal }, createRealizedVolatilityDependencies(ctx.marketData)), currentIv(),
      ]);
      ctx.signal.throwIfAborted();
      const model = projectRealizedVolatility(history.history, { symbol: instrument.symbol,
        estimator: ESTIMATOR_OPTIONS.find(({ value }) => value === args.options.estimator)?.value,
        windows, lookbackYears: Number(args.options.lookbackYears) === 2 ? 2 : 1 });
      const errors = [history.error, iv?.error].filter((value): value is string => !!value);
      // The cone rows are as of the last daily bar, not of when the report ran.
      const lastBar = model.asOf && Number.isFinite(model.asOf.getTime()) ? model.asOf.toISOString().slice(0, 10) : null;
      return {
        freshness: { asOf: lastBar },
        // The session still trading is left out of every estimate, and said, as BT says it.
        ...(model.formingNote ? { warnings: [`${model.formingNote}.`] } : {}),
        sections: [
          { title: "Volatility cone", columns: [
            { key: "window", header: "Bars" },
            ...["current", "min", "max", "mean", "median"].map((key) => ({ key, header: key,
              format: (value: unknown) => typeof value === "number" ? `${(value * 100).toFixed(2)}%` : "--" })),
            { key: "percentile", header: "Percentile", format: (value) => typeof value === "number" ? `${value.toFixed(1)}%` : "--" },
            { key: "sampleSize", header: "Samples" },
          ], rows: model.cone.map((row) => ({ ...row })) },
          { title: "Current IV", entries: [
            { label: "ATM IV", value: iv?.reference?.value ?? null, formatted: iv?.reference ? `${(iv.reference.value * 100).toFixed(2)}%` : "--" },
            { label: "Expiry", value: iv?.reference?.expiration ?? null,
              formatted: iv?.reference ? new Date(iv.reference.expiration * 1000).toISOString().slice(0, 10) : "--" },
            { label: "Days", value: iv?.reference?.daysToExpiry ?? null,
              formatted: iv?.reference ? String(Math.round(iv.reference.daysToExpiry)) : "--" },
            // To the minute, as the pane reads it; the JSON keeps the chain's read time whole.
            { label: "Observed", value: iv?.reference?.date.toISOString() ?? null,
              formatted: iv?.reference ? atmIvObservedLabel(iv.reference.date) : "--" },
          ] },
        ],
        // A short history is whole: the windows it is too short for have no estimate yet, and the note says when it starts.
        complete: model.cone.every((row) => row.current != null || model.shortWindows.includes(row.window))
          && model.warnings.length === 0 && !history.stale && errors.length === 0
          && (!args.options.showIv || iv?.reference != null || iv?.noOptionChain === true),
        unavailableSymbols: model.history.length ? [] : [instrument.symbol], errors,
        notes: [barsPerYearLabel(model.barsPerYear), ...model.historyNote ? [model.historyNote] : []],
        metadata: { unit: "decimal annualized volatility", annualization: model.barsPerYear, model, currentIv: iv,
          ...(abroad && args.options.showIv ? { notices: [`Options data covers US listings only, so ${args.symbols[0]} has no current IV.`] } : {}),
          source: history.source, stale: history.stale, fetchedAt: history.fetchedAt,
          methodology: "docs/research-data.md#shared-volatility-calculations" },
      };
    },
  };
}
