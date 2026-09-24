import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { createSurfaceDependencies } from "../vol-surface/client";
import { resolveHeadlessInstrument } from "../shared/headless-market-data";
import { createRealizedVolatilityDependencies, loadCurrentAtmIv, loadRealizedVolatilityHistory } from "./client";
import { projectRealizedVolatility, type CurrentAtmIvSnapshot } from "./model";
import { ESTIMATOR_OPTIONS, selectedWindows } from "./settings";

export function realizedVolHeadless(initialView: "graph" | "cone"): HeadlessPaneDefinition<"bundle"> {
  return {
    shape: "bundle", argument: { kind: "ticker", description: "Underlying ticker" },
    describe: (args) => `${initialView === "graph" ? "HVG" : "HVT"} ${args.symbols[0] ?? ""}`,
    discovery: { screenshotReadiness: "live-dom", limitations: ["IV is a dated current observation; HIVG has the stored IV history."] },
    options: [
      { key: "tab", type: "enum", values: [{ value: "graph" }, { value: "cone" }], defaultValue: initialView,
        description: "Initial view", pluginState: { pluginId: "ticker-research", key: "activeTabId" } },
      { key: "estimator", type: "enum", values: ESTIMATOR_OPTIONS.map(({ value }) => ({ value })), defaultValue: "close-to-close", description: "Realized volatility estimator" },
      { key: "windows", type: "string", defaultValue: "10,30,90", description: "Comma-separated session windows: 10,20,30,60,90,180,260" },
      { key: "lookbackYears", type: "integer", minimum: 1, maximum: 2, defaultValue: 1, description: "Historical lookback in calendar years" },
      { key: "showIv", type: "boolean", defaultValue: true, description: "Include a dated current ATM IV observation" },
    ],
    async load(args, ctx) {
      const windows = selectedWindows(args.options.windows);
      if (!windows.length || String(args.options.windows).split(",").some((value) => !windows.includes(Number(value)))) {
        throw new Error("Choose session windows from 10,20,30,60,90,180,260");
      }
      const instrument = await resolveHeadlessInstrument(ctx, args.symbols[0]!);
      const currentIv = async (): Promise<CurrentAtmIvSnapshot | null> => {
        if (!args.options.showIv) return null;
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
      return {
        sections: [
          { title: "Volatility cone", columns: [
            { key: "window", header: "Sessions" },
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
            { label: "Observed", value: iv?.reference?.date.toISOString() ?? null },
          ] },
        ],
        complete: model.cone.every((row) => row.current != null) && model.warnings.length === 0 && !history.stale && errors.length === 0
          && (!args.options.showIv || iv?.reference != null || iv?.noOptionChain === true),
        unavailableSymbols: model.history.length ? [] : [instrument.symbol], errors,
        metadata: { unit: "decimal annualized volatility", annualization: 252, model, currentIv: iv,
          source: history.source, stale: history.stale, fetchedAt: history.fetchedAt,
          methodology: "docs/research-data.md#shared-volatility-calculations" },
      };
    },
  };
}
