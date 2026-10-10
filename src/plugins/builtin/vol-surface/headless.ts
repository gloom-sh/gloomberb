import type { HeadlessBundleSection, HeadlessPaneDefinition, HeadlessPaneFreshness, HeadlessPaneRow } from "../../../types/plugin";
import {
  expirationOptionSeconds, OPTION_EXPIRATION_FORMAT, OPTION_EXPIRATION_PLACEHOLDER, readOptionExpiration,
} from "../../../utils/option-expiry";
import { formatStrikeLabel } from "../options/table";
import { createSurfaceDependencies, loadVolatilitySurface } from "./client";
import { buildSurfaceGrid, type SurfaceGridOptions, type SurfaceSettings, type SurfaceSnapshot } from "./model";
import {
  expiryFeedFields, expiryLabel, formatIv, formatPrice, formatVolPoints, HIDDEN_SLOPE_TEXT, HIDDEN_YIELD_TEXT, selectSurfaceExpiry, surfaceForwardRow, surfaceSkewRow,
  surfaceSmileRows, surfaceTermRows, TERM_SLOPE_MIN_DAYS, type SurfaceForwardRow, type SurfaceSkewRow,
} from "./tables";

type SurfaceAxis = NonNullable<SurfaceGridOptions["axis"]>;
const SURFACE_TABS = ["surface", "table", "smile", "term", "skew", "forwards"] as const;
type SurfaceTab = typeof SURFACE_TABS[number];

/** Column label for a surface coordinate: strike/spot or strike/forward ratio, delta bucket, or listed strike. */
export function surfaceCoordinateLabel(axis: SurfaceAxis, coordinate: number, index: number): string {
  return axis === "delta" ? ["10dP", "25dP", "ATM", "25dC", "10dC"][index] ?? String(coordinate)
    : axis === "strike" ? formatStrikeLabel(coordinate) : `${Math.round(coordinate * 100)}%`;
}

/** The Skew view's sign conventions and units, one line each. */
const SKEW_NOTES = [
  "RR is 25D call IV minus 25D put IV, BF the average 25D wing IV minus ATM IV, 90/110 the IV at 90% of spot minus the IV at 110%; all in vol points.",
  `Slope is the ATM IV change per year to the next listed expiry, in vol points; left out under ${TERM_SLOPE_MIN_DAYS} days to expiry, where it annualises a few hours of noise.`,
];

const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const iv = (value: unknown) => formatIv(number(value));
const price = (value: unknown) => formatPrice(number(value));
const points = (value: unknown) => formatVolPoints(number(value));
const days = (value: unknown) => typeof value === "number" ? value.toFixed(value < 10 ? 1 : 0) : "--";

function surfaceSections(snapshot: SurfaceSnapshot, axis: SurfaceAxis, tenors: "listed" | "fixed"): HeadlessBundleSection[] {
  const grid = buildSurfaceGrid(snapshot, { axis, tenors });
  return [
    // One row per tenor, one IV column per coordinate, as the pane's Table tab lays it out.
    { title: "Surface", columns: [
      { key: "tenor", header: "Expiry / tenor" },
      ...(grid.rows[0]?.cells.map((cell, index) => ({ key: String(index), header: surfaceCoordinateLabel(axis, cell.coordinate, index),
        format: (value: unknown) => typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "--" })) ?? []),
    ], rows: grid.rows.map((row) => ({ tenor: `${row.label}${row.extrapolated ? " E" : row.interpolated ? " I" : ""}`,
      ...Object.fromEntries(row.cells.map((cell, index) => [String(index), cell.volatility])) })) },
    { title: "Expiries", columns: [
      { key: "expiry", header: "Expiry" }, { key: "state", header: "State" }, { key: "forward", header: "Forward", format: price },
      { key: "rate", header: "Rate", format: (value) => typeof value === "number" ? `${(value * 100).toFixed(2)}%` : "--" }, { key: "fit", header: "Fit" }, { key: "asOf", header: "As of" },
    ], rows: snapshot.expiries.map((expiry) => ({ ...expiry, expiry: expiryLabel(expiry.expiration), fit: expiry.fit?.method ?? null })) },
  ];
}

/** The selected expiry's clean quotes against its fitted smile. */
function smileSections(snapshot: SurfaceSnapshot, requested: number | null): {
  sections: HeadlessBundleSection[]; errors: string[]; freshness?: HeadlessPaneFreshness;
} {
  const expiry = selectSurfaceExpiry(snapshot, requested);
  // An unlisted request is already an error naming the listed dates.
  if (!expiry) return { sections: [], errors: requested == null ? ["No expiry loaded"] : [] };
  // The quotes are one chain's, so its observation dates the report.
  const freshness: HeadlessPaneFreshness = { asOf: expiry.asOf, ...expiry.stale ? { status: "stale" as const }
    : expiry.dataSource ? { status: expiry.dataSource } : {}, ...expiry.delayMinutes ? { delayMinutes: expiry.delayMinutes } : {} };
  if (!expiry.fit || expiry.points.length < 2) {
    return { sections: [], freshness, errors: [`${expiryLabel(expiry.expiration)}: no clean quoted smile`] };
  }
  return { errors: [], freshness, sections: [
    { title: `Smile ${expiryLabel(expiry.expiration)}`, entries: [
      { key: "days", label: "Days to expiry", value: expiry.years * 365, formatted: days(expiry.years * 365) },
      { key: "forward", label: "Forward", value: expiry.forward, formatted: price(expiry.forward) },
      { key: "atm", label: "ATM IV (at spot)", value: expiry.atmIV, formatted: iv(expiry.atmIV) },
      { key: "fit", label: "Fit", value: expiry.fit.method, formatted: `${expiry.fit.method}, RMSE ${points(expiry.fit.residual)} vol pts` },
    ] },
    { title: "Clean quotes", columns: [
      { key: "strike", header: "Strike", format: (value) => typeof value === "number" ? formatStrikeLabel(value) : "--" },
      { key: "side", header: "Side" },
      { key: "moneyness", header: "Spot %", format: (value) => typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "--" },
      { key: "volatility", header: "Quote IV", format: iv }, { key: "fitted", header: "Fitted IV", format: iv },
      { key: "residual", header: "Residual pts", format: points }, { key: "mid", header: "Mid", format: price },
      { key: "openInterest", header: "OI" },
    ], rows: surfaceSmileRows(expiry) },
  ] };
}

function termSection(snapshot: SurfaceSnapshot): HeadlessBundleSection {
  return { title: "Term structure", columns: [
    { key: "expiry", header: "Expiry" }, { key: "days", header: "Days", format: days },
    { key: "atm", header: "ATM IV", format: iv }, { key: "put25", header: "25D put IV", format: iv }, { key: "call25", header: "25D call IV", format: iv },
    { key: "straddle", header: "Straddle", format: price }, { key: "sigma", header: "1-sigma", format: price },
    { key: "sigmaPercent", header: "1-sigma %", format: (value) => typeof value === "number" ? `${value.toFixed(2)}%` : "--" },
  ], rows: surfaceTermRows(snapshot).map((row) => ({ ...row, expiry: expiryLabel(row.expiration) })) };
}

function skewSection(snapshot: SurfaceSnapshot): HeadlessBundleSection {
  const gap = (value: unknown, row: HeadlessPaneRow) => typeof value === "number" ? points(value) : (row as unknown as SurfaceSkewRow).gap ?? "--";
  return { title: "Skew", columns: [
    { key: "expiry", header: "Expiry" }, { key: "days", header: "Days", format: days },
    { key: "put25", header: "25D put IV", format: iv }, { key: "call25", header: "25D call IV", format: iv },
    { key: "riskReversal", header: "RR pts", format: gap }, { key: "butterfly", header: "BF pts", format: gap },
    { key: "moneynessSkew", header: "90/110 pts", format: (value, row) => typeof value === "number" ? points(value)
      : (row as unknown as SurfaceSkewRow).moneynessGap ?? "--" },
    { key: "termSlope", header: "Slope pts/yr", format: (value, row) => typeof value === "number" ? points(value)
      : (row as unknown as SurfaceSkewRow).termSlopeHidden ? HIDDEN_SLOPE_TEXT : "--" },
  ], rows: snapshot.expiries.map((expiry) => ({ ...surfaceSkewRow(expiry), ...expiryFeedFields(expiry), expiry: expiryLabel(expiry.expiration) })) };
}

function forwardsSection(snapshot: SurfaceSnapshot): HeadlessBundleSection {
  const percent = (value: unknown) => typeof value === "number" ? `${(value * 100).toFixed(2)}%` : "--";
  return { title: "Forwards", columns: [
    { key: "expiry", header: "Expiry" }, { key: "forward", header: "Forward", format: price },
    { key: "basis", header: "Basis", format: (value) => typeof value === "number" ? `${value > 0 ? "+" : ""}${formatPrice(value)}` : "--" },
    { key: "dividendYield", header: "Div yield", format: (value, row) => typeof value === "number" ? percent(value)
      : (row as unknown as SurfaceForwardRow).dividendYieldHidden ? HIDDEN_YIELD_TEXT : "--" }, { key: "rate", header: "Rate", format: percent },
    { key: "pairs", header: "Pairs" }, { key: "asOf", header: "As of", format: (value) => typeof value === "string" ? value.slice(0, 10) : "--" },
  ], rows: snapshot.expiries.map((expiry) => ({ ...surfaceForwardRow(expiry, snapshot), ...expiryFeedFields(expiry), expiry: expiryLabel(expiry.expiration) })) };
}

export const volSurfaceHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "ticker", description: "Underlying ticker" },
  describe: (args) => `OVDV ${args.symbols[0] ?? ""}`,
  options: [
    { key: "tab", type: "enum", values: SURFACE_TABS.map((value) => ({ value })),
      defaultValue: "surface", description: "Initial view; the report prints that view's figures", pluginState: { pluginId: "ticker-research", key: "activeTabId" } },
    { key: "ivSource", type: "enum", values: [{ value: "recomputed" }, { value: "provider" }], defaultValue: "recomputed", description: "Quote-derived IV or provider comparison" },
    { key: "priceSide", type: "enum", values: [{ value: "mid" }, { value: "bid" }, { value: "ask" }], defaultValue: "mid", description: "Quote side used by the IV solver" },
    { key: "axis", type: "enum", values: ["spot", "forward", "delta", "strike"].map((value) => ({ value })), defaultValue: "spot", description: "Surface coordinates" },
    { key: "tenors", type: "enum", values: [{ value: "listed" }, { value: "fixed" }], defaultValue: "listed", description: "Listed or interpolated tenors" },
    { key: "limit", type: "integer", minimum: 1, maximum: 100, defaultValue: 18, description: "Representative expiry request limit; selected expiry may add one", pluginState: { pluginId: "ticker-research", key: "expiryLimit" } },
    { key: "expiration", type: "string", placeholder: OPTION_EXPIRATION_PLACEHOLDER, example: "--expiration 2027-01-15 --tab smile",
      description: `Selected expiry, as ${OPTION_EXPIRATION_FORMAT}; the first at least four weeks out when omitted`,
      settingKey: "expiration", normalize: (value) => expirationOptionSeconds(value) },
  ],
  async load(args, ctx) {
    const symbol = args.symbols[0]!;
    const instrument = await ctx.resolveInstrument?.(symbol) ?? { symbol };
    const quote = await ctx.marketData.getQuote(symbol, instrument.exchange);
    if (!(quote.price > 0) || !Number.isFinite(quote.price) || quote.stale) {
      return { sections: [], complete: false, unavailableSymbols: [symbol], errors: ["A current underlying price is required"] };
    }
    const requested = readOptionExpiration(args.options.expiration);
    const snapshot = await loadVolatilitySurface({ instrument, spot: quote.price, spotAsOf: quote.lastUpdated,
      settings: { ivSource: args.options.ivSource as SurfaceSettings["ivSource"], priceSide: args.options.priceSide as SurfaceSettings["priceSide"] },
      limit: Number(args.options.limit), signal: ctx.signal,
      requiredExpiries: requested == null ? [] : [requested],
    }, createSurfaceDependencies(ctx.marketData, ctx.apiClient));
    const axis = args.options.axis as SurfaceAxis;
    const tab = (SURFACE_TABS as readonly string[]).includes(String(args.options.tab)) ? args.options.tab as SurfaceTab : "surface";
    const available = snapshot.expiries.some((expiry) => expiry.fit);
    const expiryWarnings = snapshot.expiries.flatMap((expiry) => expiry.warnings.map((warning) =>
      ({ expiry: expiryLabel(expiry.expiration), warning })));
    const perExpiry = new Set(expiryWarnings.map((row) => row.warning));
    // Calendar arbitrage compares expiries, so it belongs to the whole surface.
    const warnings = [...expiryWarnings, ...snapshot.warnings.filter((warning) => !perExpiry.has(warning))
      .map((warning) => ({ expiry: "All", warning }))];
    const smile = tab === "smile" ? smileSections(snapshot, requested) : null;
    // The report prints the view it was asked for, as the pane opens on it.
    const view: HeadlessBundleSection[] = tab === "smile" ? smile!.sections : tab === "term" ? [termSection(snapshot)]
      : tab === "skew" ? [skewSection(snapshot)] : tab === "forwards" ? [forwardsSection(snapshot)]
      : surfaceSections(snapshot, axis, args.options.tenors as "listed" | "fixed");
    return {
      sections: [
        ...view,
        // The pane lists these (arbitrage, SVI fallback) beside the surface; here each names its expiry.
        ...(warnings.length ? [{ title: "Warnings", columns: [{ key: "expiry", header: "Expiry" }, { key: "warning", header: "Warning" }],
          rows: warnings }] : []),
      ],
      complete: available && snapshot.failures.length === 0 && snapshot.expiries.every((expiry) => expiry.state === "ready"),
      unavailableSymbols: available ? [] : [symbol],
      errors: [...snapshot.failures.map((failure) => failure.expiration == null ? failure.message
        : `${expiryLabel(failure.expiration)}: ${failure.message}`), ...smile?.errors ?? []],
      ...(tab === "skew" ? { notes: SKEW_NOTES } : {}),
      ...(smile?.freshness ? { freshness: smile.freshness } : {}),
      metadata: { ...snapshot, underlyingQuote: quote, unit: "decimal annualized IV", methodology: "docs/research-data.md#shared-volatility-calculations" },
    };
  },
};
