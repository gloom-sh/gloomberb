import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import {
  expirationOptionSeconds, OPTION_EXPIRATION_FORMAT, OPTION_EXPIRATION_PLACEHOLDER, readOptionExpiration,
} from "../../../utils/option-expiry";
import { resolveHeadlessInstrument } from "../shared/headless-market-data";
import {
  createScenarioDependencies, loadScenarioMarket, scenarioControlsFromSettings, scenarioPositionFromSettings,
  type ScenarioMarketSnapshot,
} from "./client";
import { buildScenario, currencyLabel, parseLegs, scenarioValueUnit } from "./model";

// Float noise at a flat origin or a breakeven prints as 0.00, not -0.00.
const money = (value: unknown) => typeof value === "number" ? (Math.abs(value) < 0.005 ? 0 : value).toFixed(2) : "--";
const percent = (value: unknown) => typeof value === "number" ? `${(value * 100).toFixed(2)}%` : "--";
const supplied = (value: unknown) => value != null && value !== "";
/** Entry prices and spot are quoted per share of the underlying. */
const PRICE_UNIT = "per share";
/** The Valuation entries, in model order, with the unit each is in. */
const VALUATION_LABELS: Record<string, (currency: string) => string> = {
  price: () => "Value", pnl: () => "P&L", delta: () => "Delta (shares)", gamma: () => "Gamma (shares per 1.00 move)",
  thetaPerDay: (currency) => `Theta (${currency} per day)`, vegaPerPoint: (currency) => `Vega (${currency} per vol point)`,
  rhoPerPoint: (currency) => `Rho (${currency} per rate point)`,
};

export const optionsScenarioHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "ticker", description: "Underlying ticker" },
  describe: (args) => `OSA ${args.symbols[0] ?? ""}`,
  discovery: { screenshotReadiness: "ready", limitations: ["European scenario values do not model early assignment or exercise."] },
  options: [
    { key: "tab", type: "enum", values: ["payoff", "grid", "legs"].map((value) => ({ value })), defaultValue: "payoff",
      description: "Initial view", pluginState: { pluginId: "ticker-research", key: "activeTabId" } },
    { key: "legs", type: "string", description: "Semicolon-separated side,strike,YYYY-MM-DD,signed quantity,entry price per share,IV percent[,multiplier]" },
    { key: "strategy", type: "enum", values: [{ value: "vertical" }, { value: "straddle" }], description: "Build an explicit example from current two-sided chain quotes" },
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
  ],
  async load(args, ctx) {
    const symbol = args.symbols[0]!;
    const settings: Record<string, unknown> = { ...ctx.settings, ...args.options, symbol };
    const suppliedInputs = !!settings.legs && ["spot", "rate", "dividendYield"].every((key) => settings[key] != null && settings[key] !== "");
    let market: ScenarioMarketSnapshot;
    if (suppliedInputs) {
      // An explicit position can be valued offline and must never depend on unrelated market requests.
      market = { ...parsePublicTickerKey(symbol), spot: null, currency: "", asOf: Date.now(), chain: null, expirationDates: [], rate: null,
        dividendYield: null, source: null, underlyingQuote: null, rateAsOf: [], warnings: [] };
    } else {
      const instrument = await resolveHeadlessInstrument(ctx, symbol);
      const typedExpiries = typeof settings.legs === "string" && settings.legs.trim() ? parseLegs(settings.legs).map((leg) => leg.expiration) : [];
      const expiration = readOptionExpiration(args.options.expiration);
      market = await loadScenarioMarket({ instrument, expiration: expiration ?? undefined,
        rateExpiration: typedExpiries.length ? Math.min(...typedExpiries) : undefined, signal: ctx.signal,
      }, createScenarioDependencies(ctx.marketData, ctx.apiClient));
    }
    ctx.signal.throwIfAborted();
    const position = scenarioPositionFromSettings(settings, market);
    const controls = position ? scenarioControlsFromSettings(settings, position) : null;
    const scenario = position && controls ? buildScenario(position, controls) : null;
    // A typed rate or yield stands in for the source that could not supply one.
    const marketWarnings = market.warnings.filter((warning) => !(supplied(settings.dividendYield) && warning.startsWith("Dividend yield unavailable"))
      && !(supplied(settings.rate) && warning.startsWith("Treasury")));
    const errors = scenario ? [...new Set([...marketWarnings, ...scenario.warnings])]
      : [...marketWarnings, "No position supplied; add --legs or select --strategy"];
    const midVolatility = !!position?.legs.some((leg) => leg.volatilitySource === "mid");
    // A seeded strategy starts at the spot its quote mids imply; the last print is reported beside it.
    const lastPrint = midVolatility && !supplied(settings.spot) && market.spot != null && money(market.spot) !== money(position!.spot)
      ? market.spot : null;
    const chain = market.chain;
    const currency = position ? currencyLabel(position.currency) : null;
    // Value, P&L, risk and the grid add every contract; entry prices and spot are per share.
    const valueUnit = position ? scenarioValueUnit(position) : null;
    const per = `${currency} ${valueUnit}`;
    return {
      freshness: suppliedInputs
        ? { source: "Your inputs", status: "not-a-feed", basis: "scenario" }
        : { asOf: market.asOf, ...(chain?.dataSource === "live" || chain?.dataSource === "delayed" ? { status: chain.dataSource } : {}),
          ...(chain?.delayMinutes ? { delayMinutes: chain.delayMinutes } : {}) },
      sections: scenario ? [
        { title: "Position", columns: [
          { key: "side", header: "Side" }, { key: "strike", header: "Strike" }, { key: "expiry", header: "Expiry" },
          { key: "quantity", header: "Contracts" }, { key: "price", header: "Entry/share", format: money },
          { key: "volatility", header: "IV", format: (value) => typeof value === "number" ? `${(value * 100).toFixed(2)}%` : "--" },
          ...(midVolatility ? [{ key: "volatilityFrom", header: "IV from" }] : []),
          { key: "multiplier", header: "Multiplier" },
        ], rows: position!.legs.map((leg) => ({ ...leg, expiry: new Date(leg.expiration * 1000).toISOString().slice(0, 10),
          ...(midVolatility ? { volatilityFrom: leg.volatilitySource === "mid" ? "quote mid" : "provider" } : {}) })) },
        { title: "Inputs", entries: [
          { key: "spot", label: lastPrint != null ? "Spot implied by option quotes" : "Spot", value: position!.spot,
            formatted: `${money(position!.spot)} ${PRICE_UNIT}` },
          ...(lastPrint != null ? [{ key: "last", label: "Last price", value: lastPrint, formatted: `${money(lastPrint)} ${PRICE_UNIT}` }] : []),
          { key: "rate", label: "Rate", value: position!.rate, formatted: percent(position!.rate) },
          { key: "dividendYield", label: "Dividend yield", value: position!.dividendYield, formatted: percent(position!.dividendYield) },
          { key: "currency", label: "Currency", value: position!.currency, formatted: currency! },
        ] },
        { title: `Valuation (${per})`, entries: Object.entries(scenario.valuation).map(([key, value]) => ({ key,
          label: VALUATION_LABELS[key]?.(currency!) ?? key, value, formatted: money(value) })) },
        { title: `Expiry risk (${per})`, entries: [
          { key: "breakevens", label: "Breakevens (spot)", value: scenario.expiryRisk.breakevens,
            formatted: scenario.expiryRisk.breakevens.map(money).join(", ") || "none" },
          { key: "maxProfit", label: "Max profit", value: scenario.expiryRisk.maxProfit, formatted: scenario.expiryRisk.unlimitedProfit ? "Unlimited" : money(scenario.expiryRisk.maxProfit) },
          { key: "maxLoss", label: "Max loss", value: scenario.expiryRisk.maxLoss, formatted: scenario.expiryRisk.unlimitedLoss ? "Unlimited" : money(scenario.expiryRisk.maxLoss) },
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
      unavailableSymbols: scenario ? [] : [symbol], errors,
      metadata: { scenario, position, controls, market, inputSource: suppliedInputs ? "user" : "market",
        unit: position?.currency || "currency unspecified",
        // Leg entry prices and spot are per share; value, P&L, risk, Greeks in currency and the grid are for valueUnit.
        ...(position ? { units: { currency: position.currency, price: PRICE_UNIT, value: valueUnit } } : {}),
        methodology: "docs/research-data.md#options-scenario-analysis" },
    };
  },
};
