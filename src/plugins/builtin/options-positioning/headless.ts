import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { loadGamma, loadOpenInterest, positioningSymbol } from "./client";
import {
  ALL_EXPIRIES,
  expiryLabel,
  formatCount,
  formatCountChange,
  formatDistance,
  formatGamma,
  formatPayout,
  formatRatio,
  formatStrike,
  POSITIONING_TABS,
  type PositioningTab,
} from "./model";

const METHODOLOGY = "docs/options-positioning.md";
const strike = (value: unknown) => typeof value === "number" ? formatStrike(value) : "--";
const count = (value: unknown) => formatCount(typeof value === "number" ? value : null);
const change = (value: unknown) => formatCountChange(typeof value === "number" ? value : null);
const gamma = (value: unknown) => formatGamma(typeof value === "number" ? value : null);

/** OPX opens on Strikes, GEX on its own tab; the report carries every section either way. */
export const optionsPositioningHeadless = (initialTab: PositioningTab): HeadlessPaneDefinition<"bundle"> => ({
  shape: "bundle",
  argument: { kind: "ticker", optional: true, description: "US option underlying, or SPX; SPY when omitted" },
  describe: (args) => `${initialTab === "gex" ? "GEX" : "OPX"} ${args.symbols[0] ?? "SPY"}`,
  discovery: {
    aliases: initialTab === "gex" ? ["GEX"] : ["OPX", "MAXPAIN"],
    screenshotReadiness: "live-dom",
    dataRequirements: ["Cloud listed open interest", "Option chains"],
    limitations: [
      "Open interest is as of the prior session's close",
      "Dealer gamma assumes dealers are long every call and short every put",
      "NDX and RUT index options are not covered; use QQQ and IWM",
    ],
  },
  options: [
    { key: "tab", type: "enum", values: POSITIONING_TABS.map((tab) => ({ value: tab.value })), defaultValue: initialTab,
      settingKey: "tab", description: "View the pane opens on: strikes, expiries or gex" },
    { key: "expiry", type: "string", settingKey: "expiry",
      description: "Expiry for the strikes and gamma, YYYY-MM-DD; the busiest near expiry when omitted (all expiries for gamma)" },
  ],
  async load(args, ctx) {
    const symbol = positioningSymbol(args.symbols[0] ?? "SPY");
    const expiry = typeof args.options.expiry === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.options.expiry)
      ? args.options.expiry : null;
    const [openInterest, dealer] = await Promise.all([
      loadOpenInterest(symbol, expiry, { signal: ctx.signal }, ctx.apiClient),
      loadGamma(symbol, expiry, { signal: ctx.signal }, ctx.apiClient).catch((error: unknown) => error instanceof Error ? error : new Error(String(error))),
    ]);
    const spot = openInterest.spot;
    const errors = [
      ...openInterest.warnings,
      ...(dealer instanceof Error ? [`Dealer gamma: ${dealer.message}`] : [
        ...dealer.warnings,
        ...(dealer.missing.length ? [`No volatility for ${dealer.missing.join(", ")}; left out of gamma`] : []),
      ]),
    ];
    const changes = openInterest.previousOiDate != null;
    return {
      sections: [
        { title: `Expiries · OI as of ${openInterest.oiDate ?? "--"}`, columns: [
          { key: "date", header: "Expiry" }, { key: "days", header: "Days" },
          { key: "callOI", header: "Call OI", format: count }, { key: "putOI", header: "Put OI", format: count },
          { key: "putCallRatio", header: "P/C", format: (value: unknown) => formatRatio(value as number | null) },
          ...(changes ? [{ key: "change", header: "OI chg", format: change }] : []),
          { key: "maxPain", header: "Max pain", format: strike },
          { key: "distance", header: "Vs spot" },
        ], rows: openInterest.expiries.map((row) => ({
          ...row,
          change: row.callChange == null ? null : row.callChange + (row.putChange ?? 0),
          distance: formatDistance(row.maxPain, spot),
        })) },
        { title: `Strikes · ${openInterest.expiry ? expiryLabel(openInterest.expiry) : "--"}`, columns: [
          { key: "strike", header: "Strike", format: strike },
          { key: "callOI", header: "Call OI", format: count },
          ...(changes ? [{ key: "callChange", header: "Call chg", format: change }] : []),
          { key: "putOI", header: "Put OI", format: count },
          ...(changes ? [{ key: "putChange", header: "Put chg", format: change }] : []),
          { key: "payout", header: "Payout $", format: (value: unknown) => formatPayout(value as number | null) },
        ], rows: openInterest.strikes.map((row) => ({ ...row })) },
        ...(dealer instanceof Error || !dealer.total ? [] : [{
          title: `Dealer gamma · ${dealer.expiry ? expiryLabel(dealer.expiry) : "all expiries"} · net ${formatGamma(dealer.total.net)} per 1% move`,
          columns: [
            { key: "strike", header: "Strike", format: strike },
            { key: "calls", header: "Call GEX $", format: gamma },
            { key: "puts", header: "Put GEX $", format: (value: unknown) => gamma(typeof value === "number" ? -value : null) },
            { key: "net", header: "Net GEX $", format: gamma },
          ],
          rows: dealer.strikes.map((row) => ({ ...row })),
        }]),
      ],
      complete: !!openInterest.expiries.length && !(dealer instanceof Error) && errors.length === 0,
      unavailableSymbols: openInterest.expiries.length ? [] : [symbol],
      errors,
      metadata: {
        underlying: openInterest.underlying,
        oiDate: openInterest.oiDate,
        previousOiDate: openInterest.previousOiDate,
        spot,
        spotAsOf: openInterest.spotAsOf,
        delayed: openInterest.delayed,
        ...(dealer instanceof Error ? {} : {
          gamma: { expiry: dealer.expiry ?? ALL_EXPIRIES, total: dealer.total, band: dealer.band, flip: dealer.flip,
            unit: "dollars of dealer delta per 1% move", assumption: "dealers long calls, short puts", quotesAsOf: dealer.quotesAsOf },
        }),
        methodology: METHODOLOGY,
      },
    };
  },
});
