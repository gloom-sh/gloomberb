import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import { resolveHeadlessInstrument } from "../shared/headless-market-data";
import {
  createScenarioDependencies, loadScenarioMarket, scenarioControlsFromSettings, scenarioPositionFromSettings,
  type ScenarioMarketSnapshot,
} from "./client";
import { buildScenario, parseLegs } from "./model";

const money = (value: unknown) => typeof value === "number" ? value.toFixed(2) : "--";

export const optionsScenarioHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "ticker", description: "Underlying ticker" },
  describe: (args) => `OSA ${args.symbols[0] ?? ""}`,
  discovery: { screenshotReadiness: "ready", limitations: ["European scenario values do not model early assignment or exercise."] },
  options: [
    { key: "tab", type: "enum", values: ["payoff", "grid", "legs"].map((value) => ({ value })), defaultValue: "payoff",
      description: "Initial view", pluginState: { pluginId: "ticker-research", key: "activeTabId" } },
    { key: "legs", type: "string", description: "Semicolon-separated side,strike,YYYY-MM-DD,signed quantity,entry price,IV percent[,multiplier]" },
    { key: "strategy", type: "enum", values: [{ value: "vertical" }, { value: "straddle" }], description: "Build an explicit example from current two-sided chain quotes" },
    { key: "expiration", type: "integer", minimum: 1, description: "Chain expiration in Unix seconds" },
    { key: "spot", type: "string", description: "Underlying price override, per share" },
    { key: "rate", type: "string", description: "Continuously compounded annual risk-free rate, percent" },
    { key: "dividendYield", aliases: ["dividend-yield"], type: "string", description: "Continuous annual dividend yield, percent" },
    { key: "currency", type: "string", description: "Monetary unit for supplied inputs, such as USD" },
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
      market = await loadScenarioMarket({ instrument,
        expiration: typeof args.options.expiration === "number" ? args.options.expiration : undefined,
        rateExpiration: typedExpiries.length ? Math.min(...typedExpiries) : undefined, signal: ctx.signal,
      }, createScenarioDependencies(ctx.marketData, ctx.apiClient));
    }
    ctx.signal.throwIfAborted();
    const position = scenarioPositionFromSettings(settings, market);
    const controls = position ? scenarioControlsFromSettings(settings, position) : null;
    const scenario = position && controls ? buildScenario(position, controls) : null;
    const errors = scenario ? [...new Set([...market.warnings, ...scenario.warnings])]
      : [...market.warnings, "No position supplied; add --legs or select --strategy"];
    return {
      sections: scenario ? [
        { title: "Position", columns: [
          { key: "side", header: "Side" }, { key: "strike", header: "Strike" }, { key: "expiry", header: "Expiry" },
          { key: "quantity", header: "Quantity" }, { key: "price", header: "Entry", format: money },
          { key: "volatility", header: "IV", format: (value) => typeof value === "number" ? `${(value * 100).toFixed(2)}%` : "--" },
          { key: "multiplier", header: "Multiplier" },
        ], rows: position!.legs.map((leg) => ({ ...leg, expiry: new Date(leg.expiration * 1000).toISOString().slice(0, 10) })) },
        { title: "Valuation", entries: Object.entries(scenario.valuation).map(([key, value]) => ({ key, label: key, value, formatted: money(value) })) },
        { title: "Expiry risk", entries: [
          { label: "Breakevens", value: scenario.expiryRisk.breakevens },
          { label: "Max profit", value: scenario.expiryRisk.maxProfit, formatted: scenario.expiryRisk.unlimitedProfit ? "Unlimited" : money(scenario.expiryRisk.maxProfit) },
          { label: "Max loss", value: scenario.expiryRisk.maxLoss, formatted: scenario.expiryRisk.unlimitedLoss ? "Unlimited" : money(scenario.expiryRisk.maxLoss) },
          ...(scenario.expiryRisk.reason ? [{ label: "Limitation", value: scenario.expiryRisk.reason }] : []),
        ] },
        { title: "Scenario grid", columns: [
          { key: "spot", header: "Spot" }, { key: "move", header: "Move", format: (value) => typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "--" },
          ...scenario.dates.map((date, index) => ({ key: `date${index}`, header: new Date(date).toISOString().slice(0, 10), format: money })),
        ], rows: scenario.grid.map((row) => ({ spot: row.spot, move: row.move,
          ...Object.fromEntries(row.values.map((value, index) => [`date${index}`, value])) })) },
      ] : [],
      complete: scenario != null && errors.length === 0,
      unavailableSymbols: scenario ? [] : [symbol], errors,
      metadata: { scenario, position, controls, market, inputSource: suppliedInputs ? "user" : "market",
        unit: position?.currency || "currency unspecified", methodology: "docs/research-data.md#options-scenario-analysis" },
    };
  },
};
