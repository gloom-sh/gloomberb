import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { createSurfaceDependencies, loadVolatilitySurface } from "./client";
import { buildSurfaceGrid, type SurfaceSettings } from "./model";

export const volSurfaceHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "ticker", description: "Underlying ticker" },
  describe: (args) => `OVDV ${args.symbols[0] ?? ""}`,
  options: [
    { key: "tab", type: "enum", values: ["surface", "table", "smile", "term", "skew", "forwards"].map((value) => ({ value })),
      defaultValue: "surface", description: "Initial view", pluginState: { pluginId: "ticker-research", key: "activeTabId" } },
    { key: "ivSource", type: "enum", values: [{ value: "recomputed" }, { value: "provider" }], defaultValue: "recomputed", description: "Quote-derived IV or provider comparison" },
    { key: "priceSide", type: "enum", values: [{ value: "mid" }, { value: "bid" }, { value: "ask" }], defaultValue: "mid", description: "Quote side used by the IV solver" },
    { key: "axis", type: "enum", values: ["spot", "forward", "delta", "strike"].map((value) => ({ value })), defaultValue: "spot", description: "Surface coordinates" },
    { key: "tenors", type: "enum", values: [{ value: "listed" }, { value: "fixed" }], defaultValue: "listed", description: "Listed or interpolated tenors" },
    { key: "limit", type: "integer", minimum: 1, maximum: 100, defaultValue: 18, description: "Maximum expiry requests", pluginState: { pluginId: "ticker-research", key: "expiryLimit" } },
    { key: "expiration", type: "integer", minimum: 1, description: "Selected expiry in Unix seconds", settingKey: "expiration" },
  ],
  async load(args, ctx) {
    const symbol = args.symbols[0]!;
    const instrument = await ctx.resolveInstrument?.(symbol) ?? { symbol };
    const quote = await ctx.marketData.getQuote(symbol, instrument.exchange);
    if (!(quote.price > 0) || !Number.isFinite(quote.price) || quote.stale) {
      return { sections: [], complete: false, unavailableSymbols: [symbol], errors: ["A current underlying price is required"] };
    }
    const snapshot = await loadVolatilitySurface({ instrument, spot: quote.price, spotAsOf: quote.lastUpdated,
      settings: { ivSource: args.options.ivSource as SurfaceSettings["ivSource"], priceSide: args.options.priceSide as SurfaceSettings["priceSide"] },
      limit: Number(args.options.limit), signal: ctx.signal,
    }, createSurfaceDependencies(ctx.marketData, ctx.apiClient));
    const grid = buildSurfaceGrid(snapshot, { axis: args.options.axis as "spot" | "forward" | "delta" | "strike", tenors: args.options.tenors as "listed" | "fixed" });
    const available = snapshot.expiries.some((expiry) => expiry.fit);
    return {
      sections: [
        { title: "Surface", columns: [
          { key: "tenor", header: "Tenor" }, { key: "coordinate", header: String(args.options.axis) },
          { key: "strike", header: "Strike" }, { key: "volatility", header: "IV", format: (value) => typeof value === "number" ? `${(value * 100).toFixed(2)}%` : "--" },
          { key: "interpolated", header: "Interpolated" }, { key: "extrapolated", header: "Extrapolated" },
        ], rows: grid.rows.flatMap((row) => row.cells.map((cell) => ({ tenor: row.label, coordinate: cell.coordinate,
          strike: cell.strike, volatility: cell.volatility, interpolated: row.interpolated, extrapolated: row.extrapolated }))) },
        { title: "Expiries", columns: [
          { key: "expiry", header: "Expiry" }, { key: "state", header: "State" }, { key: "forward", header: "Forward" },
          { key: "rate", header: "Rate" }, { key: "fit", header: "Fit" }, { key: "asOf", header: "As of" },
        ], rows: snapshot.expiries.map((expiry) => ({ ...expiry, expiry: new Date(expiry.expiration * 1000).toISOString().slice(0, 10), fit: expiry.fit?.method ?? null })) },
      ],
      complete: available && snapshot.failed === 0 && snapshot.expiries.every((expiry) => expiry.state === "ready"),
      unavailableSymbols: available ? [] : [symbol], errors: snapshot.failures.map((failure) => failure.message),
      metadata: { ...snapshot, underlyingQuote: quote, unit: "decimal annualized IV", methodology: "docs/research-data.md#shared-volatility-calculations" },
    };
  },
};
