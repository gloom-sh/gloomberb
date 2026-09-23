import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { resolveHeadlessInstrument } from "../shared/headless-market-data";
import { createRealizedVolatilityDependencies, loadRealizedVolatilityHistory } from "../realized-vol/client";
import { createHvDependencies, loadIvHistory, loadIvScreen, loadRealizedVolatilities } from "./client";
import { formatPoints, formatRank, formatStat, formatVol, verdictLabel } from "./format";
import { HV_WINDOWS, type HvWindow, type IvLookback, type IvStatRow, projectIvHistory, projectRichCheap, VCA_LIMIT, VCA_PRESETS } from "./model";
import { vcaUniverse } from "./universe";

const METHODOLOGY = "docs/research-data.md#implied-volatility-history";
const percent = (value: unknown) => typeof value === "number" ? formatVol(value) : "--";

export const ivHistoryHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "ticker", description: "US option underlying" },
  describe: (args) => `HIVG ${args.symbols[0] ?? ""}`,
  discovery: { aliases: ["HIVG"], screenshotReadiness: "live-dom", dataRequirements: ["Cloud stored implied volatility", "Daily price history"],
    limitations: ["History starts February 2024 (OPRA daily trade closes)", "Rank and percentile use trade-close readings only"] },
  options: [
    { key: "lookback", type: "enum", values: [{ value: "1Y" }, { value: "2Y" }, { value: "ALL" }], defaultValue: "1Y", description: "Visible history" },
    { key: "hvWindow", type: "enum", values: HV_WINDOWS.map((window) => ({ value: String(window) })), defaultValue: "20", description: "Realized volatility window in sessions" },
  ],
  async load(args, ctx) {
    const instrument = await resolveHeadlessInstrument(ctx, args.symbols[0]!);
    const [payload, prices] = await Promise.all([
      loadIvHistory(instrument.symbol, { signal: ctx.signal }, ctx.apiClient),
      loadRealizedVolatilityHistory({ instrument, signal: ctx.signal }, createRealizedVolatilityDependencies(ctx.marketData)),
    ]);
    const model = projectIvHistory(payload, prices.history, { lookback: String(args.options.lookback) as IvLookback,
      hvWindow: (Number(args.options.hvWindow) === 30 ? 30 : 20) as HvWindow });
    const hvByDay = new Map(model.hv.map((point) => [point.date.getTime(), point.value]));
    const rows = model.iv30.map((point, index) => ({ date: point.date.toISOString().slice(0, 10), iv30: point.value,
      iv90: model.iv90.find((entry) => entry.date.getTime() === point.date.getTime())?.value ?? null,
      hv: hvByDay.get(point.date.getTime()) ?? null, spread: model.spread[index]?.value ?? null })).reverse();
    const errors = [prices.error, ...model.warnings].filter((value): value is string => !!value);
    return {
      sections: [
        { title: "Statistics", columns: [
          { key: "label", header: "Measure" },
          { key: "value", header: "Current", format: (value: unknown, row?: unknown) => formatStat(value as number | null, (row as IvStatRow).unit) },
          { key: "date", header: "As of" }, { key: "method", header: "Source" },
          { key: "low", header: "52w low", format: (value: unknown, row?: unknown) => formatStat(value as number | null, (row as IvStatRow).unit) },
          { key: "high", header: "52w high", format: (value: unknown, row?: unknown) => formatStat(value as number | null, (row as IvStatRow).unit) },
          { key: "rank", header: "Rank", format: (value: unknown) => formatRank(value as number | null) },
          { key: "percentile", header: "Pctl", format: (value: unknown) => formatRank(value as number | null) },
          { key: "samples", header: "Sessions" },
        ], rows: model.stats.map((row) => ({ ...row })) },
        { title: "Daily history", columns: [{ key: "date", header: "Session" },
          ...["iv30", "iv90", "hv"].map((key) => ({ key, header: key.toUpperCase(), format: percent })),
          { key: "spread", header: "IV-HV", format: (value: unknown) => typeof value === "number" ? formatPoints(value) : "--" }], rows },
      ],
      complete: payload.status === "ready" && errors.length === 0,
      unavailableSymbols: model.iv30.length ? [] : [instrument.symbol], errors,
      metadata: { status: payload.status, coverage: payload.coverage, latest: payload.latest, stats: payload.stats,
        unit: "decimal annualized volatility", methodology: METHODOLOGY },
    };
  },
};

export const ivScreenHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  argument: { kind: "symbol-list", optional: true, maximum: VCA_LIMIT, description: "US option underlyings; defaults to index and sector ETFs." },
  options: [{ key: "preset", type: "enum", values: [{ value: "etfs" }, { value: "megacaps" }], defaultValue: "etfs", description: "Preset when no symbols are given" }],
  describe: "Volatility rich/cheap",
  discovery: { aliases: ["VCA"], screenshotReadiness: "live-dom", dataRequirements: ["Cloud stored implied volatility", "Daily price history"],
    limitations: ["Rich and cheap are relative to each symbol's own 52 weeks, not a fair-value model"] },
  async load(args, ctx) {
    const universe = args.symbols.length ? vcaUniverse("custom", args.symbols.join(","), null, [])
      : vcaUniverse(String(args.options.preset) === "megacaps" ? "megacaps" : "etfs", "", null, []);
    const [payload, hv] = await Promise.all([
      loadIvScreen(universe.instruments.map((instrument) => instrument.symbol), { signal: ctx.signal }, ctx.apiClient),
      loadRealizedVolatilities(universe.instruments, 20, { signal: ctx.signal }, createHvDependencies(ctx.marketData)),
    ]);
    const rows = projectRichCheap(payload.rows, hv).sort((a, b) => (b.percentile ?? -1) - (a.percentile ?? -1));
    const queued = rows.filter((row) => row.status === "queued").map((row) => row.symbol);
    return {
      sections: [{ title: `Rich/cheap · ${universe.label}`, columns: [
        { key: "symbol", header: "Symbol" }, { key: "iv30", header: "IV30", format: percent }, { key: "date", header: "As of" },
        { key: "rank", header: "IVR", format: (value: unknown) => formatRank(value as number | null) },
        { key: "percentile", header: "IVP", format: (value: unknown) => formatRank(value as number | null) },
        { key: "verdict", header: "Rich/Cheap", format: (value: unknown) => verdictLabel(value as never) },
        { key: "termSlope", header: "30-90", format: (value: unknown) => formatPoints(value as number | null) },
        { key: "skew", header: "25D skew", format: (value: unknown) => formatPoints(value as number | null) },
        { key: "hv", header: "HV20", format: percent },
        { key: "ivHv", header: "IV/HV", format: (value: unknown) => typeof value === "number" ? value.toFixed(2) : "--" },
      ], rows: rows.map((row) => ({ ...row })) }],
      complete: !queued.length && !universe.error, unavailableSymbols: queued,
      errors: [universe.error, ...(queued.length ? [`Queued for backfill: ${queued.join(", ")}`] : [])].filter((value): value is string => !!value),
      metadata: { asOf: payload.asOf, presets: VCA_PRESETS, methodology: METHODOLOGY },
    };
  },
};
