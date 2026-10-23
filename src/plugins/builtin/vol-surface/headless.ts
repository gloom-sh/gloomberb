import type { Quote } from "../../../types/financials";
import type { HeadlessBundleSection, HeadlessPaneDefinition, HeadlessPaneFreshness, HeadlessPaneLoadArgs, HeadlessPaneRow } from "../../../types/plugin";
import {
  expirationOptionSeconds, findListedExpiry, OPTION_EXPIRATION_FORMAT, OPTION_EXPIRATION_PLACEHOLDER, readOptionExpiration, unlistedExpiryText,
} from "../../../utils/option-expiry";
import { DATE_OPTION_EXAMPLES } from "../../../utils/calendar-date";
import { IMPLIED_VOL_WORDS, skewHeader } from "../iv-history/format";
import { formatStrikeLabel } from "../options/table";
import { createSurfaceDependencies, loadVolatilitySurface } from "./client";
import { buildSurfaceGrid, type SurfaceGridOptions, type SurfaceSettings, type SurfaceSnapshot } from "./model";
import { atCapturePrecision, formatCaptureTime, loadDatedSurface, storedSurfaceDate, type DatedSurfaceSnapshot } from "./stored";
import { listingFateEmpty, loadListingFate } from "../../../tickers/listing-fate";
import {
  expiryFeedFields, expiryLabel, formatIv, formatPrice, formatVolPoints, HIDDEN_SLOPE_TEXT, HIDDEN_YIELD_TEXT, selectSurfaceExpiry, surfaceForwardRow, surfaceSkewRow,
  surfaceSmileRows, surfaceSpotBasisLabel, surfaceTermRows, TERM_SLOPE_MIN_DAYS, type SurfaceForwardRow, type SurfaceSkewRow,
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
  "RR is 25D call IV minus 25D put IV, BF the average 25D wing IV minus the IV at the forward, 90/110 the IV at 90% of the forward minus the IV at 110%; all in vol points.",
  `Slope is the change per year in the IV at the forward to the next listed expiry, in vol points; left out under ${TERM_SLOPE_MIN_DAYS} days to expiry, where it annualises a few hours of noise.`,
];

/**
 * When and at what spot a stored close was taken, worded as the pane's footer
 * words it, and the settings it cannot honour: it was fitted once, on mid
 * quotes with recomputed IV.
 */
function storedNotes(snapshot: DatedSurfaceSnapshot, options: HeadlessPaneLoadArgs["options"]): string[] {
  const ignored = [options.ivSource !== "recomputed" && "--ivSource", options.priceSide !== "mid" && "--priceSide"].filter(Boolean);
  return [`Stored close, spot ${formatPrice(snapshot.spot)}, captured ${formatCaptureTime(snapshot.stored!.capturedAt)} New York.`,
    ...ignored.length ? [`A stored close is fitted on mid quotes with recomputed IV; ${ignored.join(" and ")} do${ignored.length === 1 ? "es" : ""} not apply.`] : []];
}

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
    // Each difference names its sign: the risk reversal is call minus put, unlike HIVG and VCA's put-minus-call skew.
    { key: "riskReversal", header: skewHeader("RR", "call-put"), format: gap }, { key: "butterfly", header: skewHeader("BF", "wings-ATM"), format: gap },
    { key: "moneynessSkew", header: skewHeader("90/110", "90%-110%"), format: (value, row) => typeof value === "number" ? points(value)
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
  usListingsOnly: "Options data",
  discovery: { suggestFor: IMPLIED_VOL_WORDS },
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
    { key: "date", type: "string", placeholder: "date", example: "--date 2026-10-09 --tab skew",
      description: `Stored close surface of that session, as ${DATE_OPTION_EXAMPLES}, instead of the live chain; a date with no capture lists the stored dates`,
      pluginState: { pluginId: "ticker-research", key: "historyDate" }, normalize: (value) => storedSurfaceDate(value) },
  ],
  async load(args, ctx) {
    const symbol = args.symbols[0]!;
    const requested = readOptionExpiration(args.options.expiration);
    const date = typeof args.options.date === "string" && args.options.date ? storedSurfaceDate(args.options.date) : null;
    let snapshot: DatedSurfaceSnapshot;
    let quote: Quote | null = null;
    let instrument: { symbol: string; exchange?: string } = { symbol };
    if (date) {
      // A stored close needs no current price: it carries the spot it was fitted at.
      snapshot = await loadDatedSurface(symbol, date, { signal: ctx.signal, api: ctx.apiClient });
      // An expiry the capture does not have is named against the ones it has, as the live chain names its own.
      if (requested != null && findListedExpiry(requested, snapshot.catalogue) == null) {
        snapshot = { ...snapshot, failures: [...snapshot.failures, { expiration: requested, message: unlistedExpiryText(requested, snapshot.catalogue) }] };
      }
    } else {
      const resolved = await ctx.resolveInstrument?.(symbol) ?? { symbol };
      instrument = resolved;
      quote = await ctx.marketData.getQuote(symbol, resolved.exchange);
      if (!(quote.price > 0) || !Number.isFinite(quote.price) || quote.stale) {
        // A listing that stopped trading has no current price: what became of it is why (TWTR).
        const fate = await loadListingFate(resolved, ctx.marketData, { quote });
        return { sections: [], complete: false, unavailableSymbols: [symbol],
          ...listingFateEmpty(fate, ["A current underlying price is required"]) };
      }
      // At a stored close's precision, so the live report and a --date one export the same digits. A chain
      // from a closed session is priced at that session's close, as OMON prices it.
      snapshot = atCapturePrecision(await loadVolatilitySurface({ instrument, spot: quote.price, spotAsOf: quote.lastUpdated, quote,
        settings: { ivSource: args.options.ivSource as SurfaceSettings["ivSource"], priceSide: args.options.priceSide as SurfaceSettings["priceSide"] },
        limit: Number(args.options.limit), signal: ctx.signal,
        requiredExpiries: requested == null ? [] : [requested],
      }, createSurfaceDependencies(ctx.marketData, ctx.apiClient)));
    }
    const available = snapshot.expiries.some((expiry) => expiry.fit);
    // An expiry that failed as the whole surface did (no connection) is not listed again under its own date.
    const surfaceWide = new Set(snapshot.failures.filter((failure) => failure.expiration == null).map((failure) => failure.message));
    const loadErrors = snapshot.failures.filter((failure) => failure.expiration == null || !surfaceWide.has(failure.message))
      .map((failure) => failure.expiration == null ? failure.message : `${expiryLabel(failure.expiration)}: ${failure.message}`);
    // A symbol with no option chain at all says what became of it when something did (FB is a fund now,
    // Meta trades as META) in place of the chain's own error; a chain without clean quotes is the symbol's own.
    const fate = !snapshot.stored && !available && snapshot.catalogue.length === 0
      ? listingFateEmpty(await loadListingFate(instrument, ctx.marketData, { quote }), loadErrors) : null;
    // The spot a chain from a closed session was priced at, and its session.
    const spotBasis = available ? surfaceSpotBasisLabel(snapshot) : null;
    const stored = snapshot.stored ?? null;
    const axis = args.options.axis as SurfaceAxis;
    const tab = (SURFACE_TABS as readonly string[]).includes(String(args.options.tab)) ? args.options.tab as SurfaceTab : "surface";
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
      errors: [...fate?.errors ?? loadErrors, ...smile?.errors ?? []],
      ...(fate?.empty ? { empty: fate.empty } : {}),
      ...(stored || spotBasis || tab === "skew" ? { notes: [
        ...stored ? storedNotes(snapshot, args.options) : spotBasis ? [`Spot ${formatPrice(snapshot.spot)}, ${spotBasis}.`] : [],
        ...tab === "skew" ? SKEW_NOTES : []] } : {}),
      // A stored close is dated by its session, whichever view prints it.
      ...(stored ? { freshness: { status: "not-a-feed" as const, basis: "stored close capture", asOf: stored.sessionDate } }
        : smile?.freshness ? { freshness: smile.freshness } : {}),
      metadata: { ...snapshot, ...quote ? { underlyingQuote: quote } : {}, unit: "decimal annualized IV", methodology: "docs/research-data.md#shared-volatility-calculations" },
    };
  },
};
