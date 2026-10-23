import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import {
  expirationOptionSeconds, OPTION_EXPIRATION_FORMAT, OPTION_EXPIRATION_PLACEHOLDER, readOptionExpiration,
} from "../../../utils/option-expiry";
import { resolveHeadlessInstrument } from "../shared/headless-market-data";
import {
  createScenarioDependencies, loadScenarioMarket, SCENARIO_STRATEGIES, scenarioControlsFromSettings, scenarioPositionFromSettings,
  scenarioSpotBasis, scenarioSpotStamp, suppliedScenarioInputs, type ScenarioMarketSnapshot,
} from "./client";
import { scenarioFreshness } from "./freshness";
import { cashSecuredPut, cspReportEntries, loadNextEarningsDate } from "./csp";
import { formatSpotTime } from "../options/model-spot";
import { amountUnit, buildScenario, currencyLabel, exportPercent, parseLegs, scenarioValueUnit } from "./model";
import { hedgeInputsFromSettings, hedgeReportEntries, scenarioHedgeBudget, seededLegQuotes } from "./hedge";
import { collarReportEntries, scenarioCollar } from "./collar";
import { modelDividendYieldNote } from "../../../market-data/model-dividend-yield";
import { listingFateEmpty, loadListingFate } from "../../../tickers/listing-fate";

// Float noise at a flat origin or a breakeven prints as 0.00, not -0.00.
const money = (value: unknown) => typeof value === "number" ? (Math.abs(value) < 0.005 ? 0 : value).toFixed(2) : "--";
const percent = (value: unknown) => typeof value === "number" ? `${(value * 100).toFixed(2)}%` : "--";
const supplied = (value: unknown) => value != null && value !== "";
// A seeded entry is a quote midpoint, often to the half cent (5.495), so it keeps up to four decimals.
const premium = (value: unknown) => typeof value === "number"
  ? value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4, useGrouping: false }) : "--";
/** Entry prices and spot are quoted per share of the underlying. */
const PRICE_UNIT = "per share";
/** The Valuation entries, in model order, with the unit each is in. */
const VALUATION_LABELS: Record<string, (currency: string) => string> = {
  price: () => "Value", pnl: () => "P&L", delta: () => "Delta (shares)", gamma: () => "Gamma (shares per 1.00 move)",
  thetaPerDay: (currency) => `Theta (${currency} per day)`, vegaPerPoint: (currency) => `Vega (${currency} per vol point)`,
  rhoPerPoint: (currency) => `Rho (${currency} per rate point)`,
};
/** The unit an export names beside each Valuation figure: `per` is the currency for the position (`USD per contract`). */
const VALUATION_UNITS: Record<string, (currency: string, per: string) => string> = {
  price: (_currency, per) => per, pnl: (_currency, per) => per, delta: () => "shares", gamma: () => "shares per 1.00 move",
  thetaPerDay: (currency) => `${currency} per day`, vegaPerPoint: (currency) => `${currency} per vol point`,
  rhoPerPoint: (currency) => `${currency} per rate point`,
};

export const optionsScenarioHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "ticker", description: "Underlying ticker" },
  usListingsOnly: "Options data",
  describe: (args) => `OSA ${args.symbols[0] ?? ""}`,
  description: "A typed or chain-seeded options position valued across spot, date and volatility: its legs, value and Greeks, expiry risk and a "
    + "scenario P&L grid. With --nav and --budget-bps, how many contracts a hedge budget buys, the premium spent, the notional protected and "
    + "coverage of an equity sleeve. --strategy csp sells a cash-secured put: cash secured, premium, yield on cash, annualised yield, "
    + "the bid, ask and spread with the yield at the bid, distance out of the money, break-even, days to expiry and whether earnings fall "
    + "before expiry; CSP ranks the same put across several names. --strategy collar buys a put and sells "
    + "a call against the shares they cover: net premium, floor, cap and breakevens of the hedged position.",
  discovery: { screenshotReadiness: "ready", limitations: ["European scenario values do not model early assignment or exercise."] },
  options: [
    { key: "tab", type: "enum", values: ["payoff", "grid", "legs"].map((value) => ({ value })), defaultValue: "payoff",
      description: "Initial view", pluginState: { pluginId: "ticker-research", key: "activeTabId" } },
    { key: "legs", type: "string", description: "Semicolon-separated side,strike,YYYY-MM-DD,signed quantity,entry price per share,IV percent[,multiplier]" },
    { key: "strategy", type: "enum", values: SCENARIO_STRATEGIES.map((value) => ({ value })),
      example: "--strategy collar --put-strike 345 --call-strike 420 --expiration 2027-09-30",
      description: "Build a position from current two-sided chain quotes: a call vertical, a straddle, one long put (a protective put), "
        + "csp, one short put sold at its midpoint with the cash to buy the shares set aside (a cash-secured put), "
        + "or collar, one long put and one short call on the same expiry with the shares they cover" },
    { key: "strike", type: "string", description: "The --strategy strike: the put, the vertical's long call or the straddle. Nearest the money when omitted" },
    { key: "delta", type: "string", placeholder: "0.30", example: "--strategy csp --delta 0.30 --expiration 2026-11-20",
      description: "The --strategy csp or put put by its delta instead of --strike: the one whose delta is nearest this, as a put's delta reads without its sign" },
    { key: "putStrike", aliases: ["put-strike"], type: "string",
      description: "The --strategy collar put bought. The quoted strike nearest 10% below spot when omitted" },
    { key: "callStrike", aliases: ["call-strike"], type: "string",
      description: "The --strategy collar call sold, on the put's expiry. The quoted strike nearest 10% above spot when omitted" },
    { key: "shares", type: "string", example: "--strategy collar --shares 0",
      description: "Shares of the underlying held with the options; negative for short. Typed --legs buy them at the position's spot (--spot when typed), "
        + "a --strategy seed at the spot its quotes imply, where --spot is a what-if. "
        + "A collar holds the shares its contracts cover (100 per contract); 0 values the options alone" },
    { key: "expiration", type: "string", placeholder: OPTION_EXPIRATION_PLACEHOLDER, example: "--strategy vertical --expiration 2027-01-15",
      description: `Chain expiry for --strategy, as ${OPTION_EXPIRATION_FORMAT}`, normalize: (value) => expirationOptionSeconds(value) },
    { key: "spot", type: "string", description: "Underlying price override, per share" },
    { key: "rate", type: "string", description: "Continuously compounded annual risk-free rate, percent" },
    { key: "dividendYield", aliases: ["dividend-yield"], type: "string", description: "Continuous annual dividend yield, percent" },
    { key: "currency", type: "string", description: "Currency of the inputs, such as USD; the underlying's when omitted" },
    { key: "asOf", aliases: ["as-of"], type: "string", description: "Position valuation timestamp: UTC ISO or YYYY-MM-DD" },
    { key: "date", type: "string", description: "Scenario date: UTC ISO or YYYY-MM-DD" },
    { key: "volShift", aliases: ["vol-shift"], type: "string", defaultValue: "0", description: "Parallel volatility shift, percentage points" },
    { key: "spotRange", aliases: ["spot-range"], type: "string", defaultValue: "30", description: "Spot grid range above and below current spot, percent" },
    { key: "nav", type: "string", description: "Portfolio NAV for a hedge budget, such as 100m, 2.5bn, 250k, 1,000,000 or $100m. Needs --budget-bps" },
    { key: "budgetBps", aliases: ["budget-bps"], type: "string", example: "--strategy put --strike 700 --expiration 2027-01-15 --nav 100m --budget-bps 50",
      description: "Hedge budget in basis points of --nav (50 is 0.5%): the report says how many of the position it buys, the premium, and the notional protected" },
    { key: "sleeve", aliases: ["equity-sleeve"], type: "string", description: "Equity sleeve the hedge protects, for coverage = notional / sleeve. Same amount forms as --nav" },
  ],
  async load(args, ctx) {
    const symbol = args.symbols[0]!;
    // Several names to sell puts on are a screen, not one scenario.
    const names = args.rawArgument.split(/[\s,;]+/).filter(Boolean);
    if (names.length > 1 && args.options.strategy === "csp") {
      throw new Error(`OSA values one underlying. To rank cash-secured puts across ${names.join(", ")}: gloomberb fn CSP ${names.join(" ")}`);
    }
    const settings: Record<string, unknown> = { ...ctx.settings, ...args.options, symbol };
    // Bad hedge inputs fail before any market request.
    hedgeInputsFromSettings(settings);
    const suppliedInputs = suppliedScenarioInputs(settings);
    let market: ScenarioMarketSnapshot;
    let instrument: Awaited<ReturnType<typeof resolveHeadlessInstrument>> | null = null;
    if (suppliedInputs) {
      // An explicit position can be valued offline and must never depend on unrelated market requests.
      market = { ...parsePublicTickerKey(symbol), spot: null, currency: "", asOf: Date.now(), chain: null, expirationDates: [], rate: null,
        dividendYield: null, source: null, underlyingQuote: null, rateAsOf: [], warnings: [] };
    } else {
      instrument = await resolveHeadlessInstrument(ctx, symbol);
      const typedExpiries = typeof settings.legs === "string" && settings.legs.trim() ? parseLegs(settings.legs).map((leg) => leg.expiration) : [];
      const expiration = readOptionExpiration(args.options.expiration);
      market = await loadScenarioMarket({ instrument, expiration: expiration ?? undefined,
        rateExpiration: typedExpiries.length ? Math.min(...typedExpiries) : undefined, signal: ctx.signal,
      }, createScenarioDependencies(ctx.marketData, ctx.apiClient));
    }
    // A cash-secured put says whether earnings fall before it expires; the calendar is read only for one.
    const earningsDate = settings.strategy === "csp" ? await loadNextEarningsDate(ctx.marketData, symbol) : null;
    ctx.signal.throwIfAborted();
    const position = scenarioPositionFromSettings(settings, market);
    const controls = position ? scenarioControlsFromSettings(settings, position) : null;
    const scenario = position && controls ? buildScenario(position, controls) : null;
    const hedge = scenarioHedgeBudget(settings, position, market);
    // A typed rate or yield stands in for the source that could not supply one.
    const marketWarnings = market.warnings.filter((warning) => !(supplied(settings.dividendYield) && warning.startsWith("Dividend yield unavailable"))
      && !(supplied(settings.rate) && warning.startsWith("Treasury")));
    const loadErrors = scenario ? [...new Set([...marketWarnings, ...scenario.warnings])]
      : [...marketWarnings, "No position supplied; add --legs or select --strategy"];
    // A symbol with no option chain at all says what became of it when something did (TWTR stopped
    // trading, FB is a fund now) in place of the chain's errors.
    const fate = instrument && !market.chain && !scenario
      ? listingFateEmpty(await loadListingFate(instrument, ctx.marketData, market.underlyingQuote ? { quote: market.underlyingQuote } : {}), loadErrors) : null;
    const errors = fate?.errors ?? loadErrors;
    const midVolatility = !!position?.legs.some((leg) => leg.volatilitySource === "mid");
    // A seeded strategy starts at the spot its quote mids imply; the last print is reported beside it.
    const lastPrint = midVolatility && !supplied(settings.spot) && market.spot != null && money(market.spot) !== money(position!.spot)
      ? market.spot : null;
    const spotBasis = position ? scenarioSpotBasis(settings, position, market) : null;
    const csp = position && settings.strategy === "csp"
      ? cashSecuredPut(position, spotBasis!, earningsDate, seededLegQuotes(position, market.chain).get(position.legs[0]?.id ?? "")) : null;
    // A collar seeded, or one typed with the shares it hedges.
    const collar = position && (settings.strategy === "collar" || position.underlying) ? scenarioCollar(position, spotBasis!) : null;
    const lastSession = market.underlyingQuote && spotBasis === "implied by option quotes"
      ? scenarioSpotBasis({}, { spot: market.spot!, legs: [] }, market) : null;
    const currency = position ? currencyLabel(position.currency) : null;
    const dividendNote = supplied(settings.dividendYield) ? null
      : modelDividendYieldNote({ basis: market.dividendYieldBasis ?? "stated", lastPaid: market.dividendLastPaid });
    // Value, P&L, risk and the grid add every contract; entry prices and spot are per share.
    const valueUnit = position ? scenarioValueUnit(position) : null;
    const per = `${currency} ${valueUnit}`;
    // What an export names beside each number: the currency (or `currency unknown`) and what it is for.
    const exportCurrency = position ? amountUnit(position.currency) : "";
    const exportPer = `${exportCurrency} ${valueUnit}`;
    const perShare = `${exportCurrency} ${PRICE_UNIT}`;
    return {
      freshness: scenarioFreshness(market, suppliedInputs),
      sections: scenario ? [
        { title: "Position", columns: [
          { key: "side", header: "Side" }, { key: "strike", header: "Strike" }, { key: "expiry", header: "Expiry" },
          { key: "quantity", header: "Contracts" }, { key: "price", header: "Entry/share", format: premium },
          { key: "volatility", header: "IV", format: (value) => typeof value === "number" ? `${(value * 100).toFixed(2)}%` : "--" },
          ...(midVolatility ? [{ key: "volatilityFrom", header: "IV from" }] : []),
          { key: "multiplier", header: "Multiplier" },
        ], rows: position!.legs.map((leg) => ({ ...leg, expiry: new Date(leg.expiration * 1000).toISOString().slice(0, 10),
          ...(midVolatility ? { volatilityFrom: leg.volatilitySource === "mid" ? "quote mid" : "provider" } : {}) })) },
        { title: "Inputs", entries: [
          { key: "spot", label: lastPrint != null ? "Spot implied by option quotes" : "Spot", value: position!.spot, unit: perShare,
            formatted: `${money(position!.spot)} ${PRICE_UNIT}${lastPrint == null && spotBasis !== "last price" ? ` (${scenarioSpotStamp(spotBasis!, position!.asOf)})` : ""}` },
          ...(lastPrint != null ? [{ key: "last", label: "Last price", value: lastPrint, unit: perShare,
            formatted: `${money(lastPrint)} ${PRICE_UNIT}${lastSession && lastSession !== "last price" ? ` (${scenarioSpotStamp(lastSession, market.asOf)})` : ""}` }] : []),
          ...(position!.underlying ? [{ key: "shares", label: "Shares held", value: position!.underlying.quantity, unit: "shares",
            formatted: `${position!.underlying.quantity.toLocaleString("en-US")} at ${money(position!.underlying.price)} ${PRICE_UNIT}` }] : []),
          { key: "asOf", label: "Valued at", value: new Date(position!.asOf).toISOString(), formatted: formatSpotTime(position!.asOf) },
          { key: "rate", label: "Rate", value: exportPercent(position!.rate), unit: "%", formatted: percent(position!.rate) },
          // A yield read as 0 because no dividend was paid, or the dividend stopped, says so; a stated or typed one is the figure alone.
          { key: "dividendYield", label: "Dividend yield", value: exportPercent(position!.dividendYield), unit: "%", formatted: percent(position!.dividendYield)
            + (dividendNote ? ` (${dividendNote})` : "") },
          { key: "currency", label: "Currency", value: position!.currency, formatted: currency! },
        ] },
        ...(hedge ? [{ title: "Hedge budget", entries: hedgeReportEntries(hedge) }] : []),
        ...(csp ? [{ title: "Cash-secured put", entries: cspReportEntries(csp) }] : []),
        ...(collar ? [{ title: "Collar", entries: collarReportEntries(collar) }] : []),
        { title: `Valuation (${per})`, entries: Object.entries(scenario.valuation).map(([key, value]) => ({ key,
          label: VALUATION_LABELS[key]?.(currency!) ?? key, value, formatted: money(value),
          ...(VALUATION_UNITS[key] ? { unit: VALUATION_UNITS[key]!(exportCurrency, exportPer) } : {}) })) },
        { title: `Expiry risk (${per})`, entries: [
          { key: "breakevens", label: "Breakevens (spot)", value: scenario.expiryRisk.breakevens, unit: perShare,
            formatted: scenario.expiryRisk.breakevens.map(money).join(", ") || "none" },
          { key: "maxProfit", label: "Max profit", value: scenario.expiryRisk.maxProfit, unit: exportPer, formatted: scenario.expiryRisk.unlimitedProfit ? "Unlimited" : money(scenario.expiryRisk.maxProfit) },
          { key: "maxLoss", label: "Max loss", value: scenario.expiryRisk.maxLoss, unit: exportPer, formatted: scenario.expiryRisk.unlimitedLoss ? "Unlimited" : money(scenario.expiryRisk.maxLoss) },
          ...(scenario.expiryRisk.reason ? [{ key: "limitation", label: "Limitation", value: scenario.expiryRisk.reason }] : []),
        ] },
        { title: `Scenario grid (P&L, ${per})`, columns: [
          { key: "spot", header: "Spot/share", format: money },
          { key: "move", header: "Move", format: (value) => typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "--" },
          ...scenario.dates.map((date, index) => ({ key: `date${index}`, header: new Date(date).toISOString().slice(0, 10), format: money })),
        ], rows: scenario.grid.map((row) => ({ spot: row.spot, move: row.move,
          ...Object.fromEntries(row.values.map((value, index) => [`date${index}`, value])) })) },
      ] : [],
      complete: scenario != null && errors.length === 0,
      unavailableSymbols: scenario ? [] : [symbol], errors, ...(fate?.empty ? { empty: fate.empty } : {}),
      metadata: { scenario, position, controls, market, ...(hedge ? { hedge } : {}), ...(csp ? { csp } : {}), ...(collar ? { collar } : {}),
        ...(position ? { spot: { price: position.spot, basis: spotBasis, valuedAt: new Date(position.asOf).toISOString() } } : {}),
        inputSource: suppliedInputs ? "user" : "market",
        unit: position?.currency || "currency unspecified",
        // Leg entry prices and spot are per share; value, P&L, risk, Greeks in currency and the grid are for valueUnit.
        ...(position ? { units: { currency: position.currency, price: PRICE_UNIT, value: valueUnit } } : {}),
        methodology: "docs/research-data.md#options-scenario-analysis" },
    };
  },
};
