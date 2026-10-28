import type { HeadlessPaneDefinition, HeadlessPaneEntry } from "../../../types/plugin";
import { formatStrikeLabel } from "../../../utils/options";
import { expirationOptionSeconds, expiryIsoDate, OPTION_EXPIRATION_FORMAT, OPTION_EXPIRATION_PLACEHOLDER } from "../../../utils/option-expiry";
import { formatUtcTime } from "../../../utils/utc-time";
import { loadGamma, loadOpenInterest, positioningSymbol, type GammaPayload, type OpenInterestPayload } from "./client";
import { listingFateReport, loadListingFate } from "../../../tickers/listing-fate";
import { resolveHeadlessInstrument } from "../shared/headless-market-data";
import { coinOptionsAlias, coinWithoutOptionsRefusal } from "../../../market-data/options-alternatives";
import {
  ALL_EXPIRIES,
  expiryLabel,
  expiryWithTimeLabel,
  formatContracts,
  isCoinContract,
  settlementTime,
  wallsByExpiry,
  formatCount,
  formatCountChange,
  formatDistance,
  formatGamma,
  formatGammaTimes,
  formatLevel,
  formatPositioningSpot,
  formatPayout,
  formatRatio,
  GAMMA_UNIT,
  gammaWalls,
  netGammaByExpiry,
  POSITIONING_TABS,
  type PositioningTab,
} from "./model";

const METHODOLOGY = "https://gloom.sh/docs/options-positioning";
const UNIT_TEXT = "$ of dealer delta per 1% move";
const strike = (value: unknown) => typeof value === "number" ? formatStrikeLabel(value) : "--";
const count = (value: unknown) => formatCount(typeof value === "number" ? value : null);
const coinCount = (value: unknown) => formatContracts(typeof value === "number" ? value : null, true);
const change = (value: unknown) => formatCountChange(typeof value === "number" ? value : null);
const gamma = (value: unknown) => formatGamma(typeof value === "number" ? value : null);
const failure = (error: unknown) => error instanceof Error ? error : new Error(String(error));
const time = (value: string | null) => value ? formatUtcTime(value) : "--";
const level = (value: number | null, spot: number | null, none = "--") =>
  value == null ? none : `${formatLevel(value)}, ${formatDistance(value, spot)} vs spot`;
const wall = (value: number | null, spot: number | null) =>
  value == null ? "--" : `${formatStrikeLabel(value)}, ${formatDistance(value, spot)} vs spot`;

/**
 * What the report opens with: spot, the instant gamma is evaluated at and
 * when the quotes behind its volatilities were taken, apart from the open
 * interest session, then the figures the GEX tab shows. Exports keep each
 * figure whole; the text says them as the pane does.
 */
function summary(openInterest: OpenInterestPayload, dealer: GammaPayload | null): { entries: HeadlessPaneEntry[]; textEntries: HeadlessPaneEntry[] } {
  // Gamma is priced at its own read of spot; the figures and their distances use that one.
  const spot = dealer?.spot ?? openInterest.spot;
  const spotAsOf = dealer ? dealer.spotAsOf : openInterest.spotAsOf;
  const spotBasis = dealer ? dealer.spotBasis : openInterest.spotBasis;
  const venue = openInterest.venue;
  // Older servers send no gamma time: their quote time stands alone, as it did.
  const gammaTimes = dealer ? formatGammaTimes(dealer.gammaAsOf, dealer.quotesAsOf) : null;
  // A venue that publishes open interest live (Deribit) dates it to the read, not to a session.
  const oiAsOf = venue && openInterest.oiAsOf ? openInterest.oiAsOf : null;
  const contract = openInterest.contract;
  const settles = settlementTime(openInterest.expiries[0]?.expiresAt);
  const entries: HeadlessPaneEntry[] = [
    ...(venue ? [{ key: "venue", label: "Venue", value: venue }] : []),
    { key: "spot", label: "Spot", value: spot },
    { key: "spotAsOf", label: "Spot as of", value: spotAsOf },
    // An index outside its session: spot is the close, spotAsOf its time.
    ...(spotBasis ? [{ key: "spotBasis", label: "Spot basis", value: spotBasis }] : []),
    ...(dealer && gammaTimes ? [{ key: "gammaAsOf", label: "Gamma at", value: dealer.gammaAsOf ?? null },
      { key: "quotesAsOf", label: "Vols from", value: dealer.quotesAsOf }]
      : dealer ? [{ key: "quotesAsOf", label: "Quotes as of", value: dealer.quotesAsOf }] : []),
    { key: "oiDate", label: "Open interest as of", value: oiAsOf ?? openInterest.oiDate },
    ...(contract ? [{ key: "contract", label: "Contract", value: contract }] : []),
    ...(settles ? [{ key: "settles", label: "Expiries settle", value: settles }] : []),
  ];
  const textEntries: HeadlessPaneEntry[] = [
    ...(venue ? [{ label: "Venue", value: venue }] : []),
    { label: "Spot", value: spot, formatted: formatPositioningSpot(spot, spotAsOf, venue, spotBasis) },
    ...(dealer && gammaTimes ? [{ label: "Gamma at", value: dealer.gammaAsOf ?? null, formatted: gammaTimes }]
      : dealer ? [{ label: "Quotes as of", value: dealer.quotesAsOf, formatted: time(dealer.quotesAsOf) }] : []),
    { label: "Open interest as of", value: oiAsOf ?? openInterest.oiDate, formatted: oiAsOf ? `${time(oiAsOf)}, live` : openInterest.oiDate ?? "--" },
    ...(contract ? [{ label: "Contract", value: contract, formatted: `${contract.size} ${contract.unit}; OI counts ${contract.unit}` }] : []),
    ...(settles ? [{ label: "Expiries settle", value: settles, formatted: `${settles}, the day each expiry names` }] : []),
  ];
  if (!dealer?.total) return { entries, textEntries };
  const { callWall, putWall } = gammaWalls(dealer.strikes);
  const band = dealer.band;
  const amount = (key: string, label: string, value: number): HeadlessPaneEntry => ({ key, label, value, unit: GAMMA_UNIT });
  entries.push(
    { key: "unit", label: "Unit", value: UNIT_TEXT },
    amount("net", "Net GEX", dealer.total.net),
    ...(band ? [amount("rangeLow", "Dealer range low", band.low), amount("rangeHigh", "Dealer range high", band.high)] : []),
    ...(dealer.bandWithBoxes ? [amount("rangeWithBoxesLow", "Dealer range with boxes low", dealer.bandWithBoxes.low),
      amount("rangeWithBoxesHigh", "Dealer range with boxes high", dealer.bandWithBoxes.high)] : []),
    { key: "flip", label: "Flip", value: dealer.flip },
    { key: "callWall", label: "Call wall", value: callWall },
    { key: "putWall", label: "Put wall", value: putWall },
  );
  textEntries.push(
    { label: "Unit", value: UNIT_TEXT },
    { label: "Net GEX", value: dealer.total.net, formatted: formatGamma(dealer.total.net) },
    ...(band ? [{ label: "Dealer range", value: band, formatted: `${formatGamma(band.low)} to ${formatGamma(band.high)}, `
      + `${Math.round(band.shareLow * 100)}-${Math.round(band.shareHigh * 100)}% with dealers${dealer.boxes?.length ? ", boxes out" : ""}` }] : []),
    { label: "Flip", value: dealer.flip, formatted: level(dealer.flip, spot, "none within 15%") },
    { label: "Call wall", value: callWall, formatted: wall(callWall, spot) },
    { label: "Put wall", value: putWall, formatted: wall(putWall, spot) },
  );
  return { entries, textEntries };
}

/** OPX opens on Strikes, GEX on its own tab; the report carries every section either way. */
export const optionsPositioningHeadless = (initialTab: PositioningTab): HeadlessPaneDefinition<"bundle"> => ({
  shape: "bundle",
  freshness: { status: "not-a-feed", basis: "daily open interest", cadence: "daily" },
  argument: { kind: "ticker", optional: true, description: "US option underlying, BTC-USD or ETH-USD, or SPX; SPY when omitted" },
  usListingsOnly: "Options data",
  symbolAlias: coinOptionsAlias(initialTab === "gex" ? "GEX" : "OPX"),
  refuseSymbol: coinWithoutOptionsRefusal(initialTab === "gex" ? "GEX" : "OPX"),
  describe: (args) => `${initialTab === "gex" ? "GEX" : "OPX"} ${args.symbols[0] ?? "SPY"}`,
  discovery: {
    aliases: initialTab === "gex" ? ["GEX"] : ["OPX", "MAXPAIN"],
    screenshotReadiness: "live-dom",
    dataRequirements: ["Cloud listed open interest", "Option chains"],
    limitations: [
      "Open interest is about two sessions old; the Expiries heading names its date.",
      "Dealer gamma assumes dealers are long every call and short every put.",
      "NDX and RUT index options are not covered; use QQQ and IWM.",
      "BTC-USD and ETH-USD are Deribit's options: open interest is live and counted in coins, and expiries settle at 08:00 UTC.",
    ],
  },
  options: [
    { key: "tab", type: "enum", values: POSITIONING_TABS.map((tab) => ({ value: tab.value })), defaultValue: initialTab,
      settingKey: "tab", description: "View the pane opens on: strikes, expiries or gex" },
    { key: "expiry", type: "string", settingKey: "expiry", placeholder: OPTION_EXPIRATION_PLACEHOLDER, example: "--expiry 2027-01-15",
      description: `Expiry for the strikes and gamma, as ${OPTION_EXPIRATION_FORMAT}; the busiest near expiry when omitted (all expiries for gamma)`,
      normalize: (value) => expiryIsoDate(expirationOptionSeconds(value, "expiry")) },
  ],
  async load(args, ctx) {
    const symbol = positioningSymbol(args.symbols[0] ?? "SPY");
    const expiry = typeof args.options.expiry === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.options.expiry)
      ? args.options.expiry : null;
    const [openInterest, dealer, everyExpiry] = await Promise.all([
      loadOpenInterest(symbol, expiry, { signal: ctx.signal }, ctx.apiClient),
      loadGamma(symbol, expiry, { signal: ctx.signal }, ctx.apiClient).catch(failure),
      // The Expiries table's Net GEX is every expiry's, whichever one the strikes and gamma are for.
      expiry ? loadGamma(symbol, null, { signal: ctx.signal }, ctx.apiClient).catch(failure) : null,
    ]);
    const spot = openInterest.spot;
    const allExpiries = everyExpiry ?? dealer;
    // VIX has no dealer gamma, so its expiries have no column for it.
    const expiryGamma = !(allExpiries instanceof Error) && allExpiries.total ? netGammaByExpiry(allExpiries) : null;
    const gammaColumn = allExpiries instanceof Error || !!allExpiries.total;
    const loadErrors = [
      ...openInterest.warnings,
      ...(dealer instanceof Error ? [`Dealer gamma: ${dealer.message}`] : [
        ...dealer.warnings,
        ...(dealer.missing.length ? [`No volatility for ${dealer.missing.join(", ")}; left out of gamma`] : []),
      ]),
      ...(everyExpiry instanceof Error ? [`Net GEX by expiry: ${everyExpiry.message}`] : []),
    ];
    // A symbol with no listed open interest says what became of it when something did (TWTR stopped
    // trading, FB is a fund now) in place of the load's errors.
    const fate = openInterest.expiries.length || expiry ? null
      : listingFateReport(await loadListingFate(await resolveHeadlessInstrument(ctx, symbol), ctx.marketData), { served: false }, loadErrors);
    const errors = fate?.errors ?? loadErrors;
    const changes = openInterest.previousOiDate != null;
    const coin = isCoinContract(openInterest.contract);
    const contracts = coin ? coinCount : count;
    const unit = coin ? ` (${openInterest.contract!.unit})` : "";
    // Each expiry's walls, from the all-expiries gamma; absent from older servers.
    const expiryWalls = allExpiries instanceof Error ? null : wallsByExpiry(allExpiries);
    const settles = openInterest.expiries.some((row) => settlementTime(row.expiresAt));
    const oiStamp = openInterest.venue && openInterest.oiAsOf ? `${time(openInterest.oiAsOf)}, live` : openInterest.oiDate ?? "--";
    const gammaShown = dealer instanceof Error || !dealer.total ? null : dealer;
    const scope = dealer instanceof Error ? null : dealer.expiry ? expiryLabel(dealer.expiry) : "all expiries";
    const walls = gammaShown ? gammaWalls(gammaShown.strikes) : null;
    return {
      // Open interest is counted once a day and arrives about two sessions late, dated in the heading and the summary;
      // spot and the quotes have their own times in the summary.
      // A venue's live book (Deribit's) is a feed: read a minute ago, or held back 15 minutes for delayed access.
      freshness: openInterest.venue && openInterest.oiAsOf
        ? { asOf: openInterest.oiAsOf, status: openInterest.delayed ? "delayed" as const : "live" as const,
          ...(openInterest.delayed ? { delayMinutes: 15 } : {}) }
        : { asOf: openInterest.oiDate },
      sections: [
        { title: scope ? `Summary · ${scope}` : "Summary", ...summary(openInterest, dealer instanceof Error ? null : dealer) },
        { title: `Expiries · OI as of ${oiStamp}`, columns: [
          { key: "date", header: "Expiry" },
          // Deribit's expiries settle at 08:00 UTC on the day they name.
          ...(settles ? [{ key: "settles", header: "Settles" }] : []),
          { key: "days", header: "Days" },
          { key: "callOI", header: `Call OI${unit}`, format: contracts }, { key: "putOI", header: `Put OI${unit}`, format: contracts },
          { key: "putCallRatio", header: "P/C", format: (value: unknown) => formatRatio(value as number | null) },
          ...(changes ? [{ key: "change", header: "OI chg", format: change }] : []),
          { key: "maxPain", header: "Max pain", format: strike },
          { key: "distance", header: "Vs spot" },
          ...(expiryWalls ? [{ key: "callWall", header: "Call wall", format: strike }, { key: "putWall", header: "Put wall", format: strike }] : []),
          ...(gammaColumn ? [{ key: "netGamma", header: "Net GEX $", format: gamma, unitKey: "netGammaUnit" }] : []),
        ], rows: openInterest.expiries.map((row) => ({
          ...row,
          ...(settles ? { settles: settlementTime(row.expiresAt) } : {}),
          change: row.callChange == null ? null : row.callChange + (row.putChange ?? 0),
          distance: formatDistance(row.maxPain, spot),
          ...(expiryWalls ? { callWall: expiryWalls.get(row.date)?.callWall ?? null, putWall: expiryWalls.get(row.date)?.putWall ?? null } : {}),
          ...(gammaColumn ? { netGamma: expiryGamma?.get(row.date) ?? null, netGammaUnit: GAMMA_UNIT } : {}),
        })) },
        { title: `Strikes · ${openInterest.expiry
          ? expiryWithTimeLabel(openInterest.expiries.find((row) => row.date === openInterest.expiry) ?? { date: openInterest.expiry }) : "--"}`, columns: [
          { key: "strike", header: "Strike", format: strike },
          { key: "callOI", header: `Call OI${unit}`, format: contracts },
          ...(changes ? [{ key: "callChange", header: "Call chg", format: change }] : []),
          { key: "putOI", header: `Put OI${unit}`, format: contracts },
          ...(changes ? [{ key: "putChange", header: "Put chg", format: change }] : []),
          { key: "payout", header: "Payout $", format: (value: unknown) => formatPayout(value as number | null) },
        ], rows: openInterest.strikes.map((row) => ({ ...row })) },
        ...(gammaShown ? [{
          title: `Dealer gamma · ${scope}`,
          unit: GAMMA_UNIT,
          columns: [
            { key: "strike", header: "Strike", format: strike },
            { key: "calls", header: "Call GEX $", format: gamma },
            { key: "puts", header: "Put GEX $", format: gamma },
            { key: "net", header: "Net GEX $", format: gamma },
          ],
          // Puts are signed as the table draws them, so calls and puts add up to net.
          rows: gammaShown.strikes.map((row) => ({ strike: row.strike, calls: row.calls, puts: row.puts === 0 ? 0 : -row.puts, net: row.net })),
        }] : []),
      ],
      complete: !!openInterest.expiries.length && !(dealer instanceof Error) && errors.length === 0,
      unavailableSymbols: openInterest.expiries.length ? [] : [symbol],
      errors, ...(fate?.notes.length ? { notes: fate.notes } : {}),
      metadata: {
        underlying: openInterest.underlying,
        oiDate: openInterest.oiDate,
        previousOiDate: openInterest.previousOiDate,
        spot,
        spotAsOf: openInterest.spotAsOf,
        ...(openInterest.spotBasis ? { spotBasis: openInterest.spotBasis } : {}),
        delayed: openInterest.delayed,
        ...(openInterest.venue ? { venue: openInterest.venue, oiAsOf: openInterest.oiAsOf ?? null, contract: openInterest.contract ?? null } : {}),
        ...(dealer instanceof Error ? {} : {
          gamma: { expiry: dealer.expiry ?? ALL_EXPIRIES, spot: dealer.spot, spotAsOf: dealer.spotAsOf,
            ...(dealer.spotBasis ? { spotBasis: dealer.spotBasis } : {}), total: dealer.total, band: dealer.band,
            bandWithBoxes: dealer.bandWithBoxes ?? null, boxes: dealer.boxes ?? [], flip: dealer.flip,
            callWall: walls?.callWall ?? null, putWall: walls?.putWall ?? null,
            unit: "dollars of dealer delta per 1% move", assumption: "dealers long calls, short puts",
            gammaAsOf: dealer.gammaAsOf ?? null, quotesAsOf: dealer.quotesAsOf },
        }),
        methodology: METHODOLOGY,
      },
    };
  },
});
