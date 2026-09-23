import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { formatStrikeLabel } from "../options/table";
import { createSurfaceDependencies, loadVolatilitySurface } from "./client";
import { buildSurfaceGrid, type SurfaceGridOptions, type SurfaceSettings } from "./model";

type SurfaceAxis = NonNullable<SurfaceGridOptions["axis"]>;

/** Column label for a surface coordinate: strike/spot or strike/forward ratio, delta bucket, or listed strike. */
export function surfaceCoordinateLabel(axis: SurfaceAxis, coordinate: number, index: number): string {
  return axis === "delta" ? ["10dP", "25dP", "ATM", "25dC", "10dC"][index] ?? String(coordinate)
    : axis === "strike" ? formatStrikeLabel(coordinate) : `${Math.round(coordinate * 100)}%`;
}

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
    { key: "limit", type: "integer", minimum: 1, maximum: 100, defaultValue: 18, description: "Representative expiry request limit; selected expiry may add one", pluginState: { pluginId: "ticker-research", key: "expiryLimit" } },
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
      requiredExpiries: typeof args.options.expiration === "number" ? [args.options.expiration] : [],
    }, createSurfaceDependencies(ctx.marketData, ctx.apiClient));
    const axis = args.options.axis as SurfaceAxis;
    const grid = buildSurfaceGrid(snapshot, { axis, tenors: args.options.tenors as "listed" | "fixed" });
    const available = snapshot.expiries.some((expiry) => expiry.fit);
    const expiryWarnings = snapshot.expiries.flatMap((expiry) => expiry.warnings.map((warning) =>
      ({ expiry: new Date(expiry.expiration * 1000).toISOString().slice(0, 10), warning })));
    const perExpiry = new Set(expiryWarnings.map((row) => row.warning));
    // Calendar arbitrage compares expiries, so it belongs to the whole surface.
    const warnings = [...expiryWarnings, ...snapshot.warnings.filter((warning) => !perExpiry.has(warning))
      .map((warning) => ({ expiry: "All", warning }))];
    return {
      sections: [
        // One row per tenor, one IV column per coordinate, as the pane's Table tab lays it out.
        { title: "Surface", columns: [
          { key: "tenor", header: "Expiry / tenor" },
          ...(grid.rows[0]?.cells.map((cell, index) => ({ key: String(index), header: surfaceCoordinateLabel(axis, cell.coordinate, index),
            format: (value: unknown) => typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "--" })) ?? []),
        ], rows: grid.rows.map((row) => ({ tenor: `${row.label}${row.extrapolated ? " E" : row.interpolated ? " I" : ""}`,
          ...Object.fromEntries(row.cells.map((cell, index) => [String(index), cell.volatility])) })) },
        { title: "Expiries", columns: [
          { key: "expiry", header: "Expiry" }, { key: "state", header: "State" }, { key: "forward", header: "Forward", format: (value) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "--" },
          { key: "rate", header: "Rate", format: (value) => typeof value === "number" ? `${(value * 100).toFixed(2)}%` : "--" }, { key: "fit", header: "Fit" }, { key: "asOf", header: "As of" },
        ], rows: snapshot.expiries.map((expiry) => ({ ...expiry, expiry: new Date(expiry.expiration * 1000).toISOString().slice(0, 10), fit: expiry.fit?.method ?? null })) },
        // The pane lists these (arbitrage, SVI fallback) beside the surface; here each names its expiry.
        ...(warnings.length ? [{ title: "Warnings", columns: [{ key: "expiry", header: "Expiry" }, { key: "warning", header: "Warning" }],
          rows: warnings }] : []),
      ],
      complete: available && snapshot.failures.length === 0 && snapshot.expiries.every((expiry) => expiry.state === "ready"),
      unavailableSymbols: available ? [] : [symbol], errors: snapshot.failures.map((failure) => failure.message),
      metadata: { ...snapshot, underlyingQuote: quote, unit: "decimal annualized IV", methodology: "docs/research-data.md#shared-volatility-calculations" },
    };
  },
};
