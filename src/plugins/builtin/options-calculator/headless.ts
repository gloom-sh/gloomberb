import type { HeadlessBundleResult, HeadlessPaneDefinition, HeadlessPaneEntry } from "../../../types/plugin";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import { effectiveBinomialSteps, valueBinomialOption, solveBinomialImpliedVolatility } from "./binomial";
import { draftFromCalculatorInputs } from "./inputs";
import { solveImpliedVolatility, valueOption, type OptionCalcDraft, type OptionValuation } from "./model";
import { createCalculatorSurfaceDependencies, loadCalculatorSurfaceVol, type CalculatorSurfaceVol } from "./surface";

const number = (value: number) => Number.isFinite(value) ? value.toFixed(6) : "--";
const metric = (label: string, value: number, suffix = ""): HeadlessPaneEntry => ({ label, value, formatted: `${number(value)}${suffix}` });

function report(draft: OptionCalcDraft, valuation: OptionValuation | null,
  implied: { volatility: number | null; note: string | null }, surface: CalculatorSurfaceVol | null,
  errors: string[], effectiveTreeSteps: number | null = null): HeadlessBundleResult {
  const model = draft.pricingModel ?? "european";
  return {
    sections: [
      { title: "Inputs", entries: [
        ...(draft.symbol ? [{ label: "Underlying", value: draft.symbol }] : []),
        { label: "Model", value: model }, { label: "Side", value: draft.side },
        metric("Spot", draft.spot), metric("Strike", draft.strike), metric("Days to expiry", draft.daysToExpiry),
        metric("Volatility", draft.volatility, " decimal"), metric("Annual rate", draft.rate, " decimal"),
        metric("Annual dividend yield", draft.dividendYield, " decimal"),
        ...(model === "american" ? [{ label: "Requested tree steps", value: draft.steps ?? 400 }] : []),
        ...(effectiveTreeSteps != null && effectiveTreeSteps !== (draft.steps ?? 400)
          ? [{ label: "Effective tree steps", value: effectiveTreeSteps }] : []),
        { label: "Volatility source", value: surface?.source ?? "input assumptions" },
      ] },
      ...(draft.dividends?.length ? [{ title: "Cash dividends", columns: [
        { key: "days", header: "Days" }, { key: "amount", header: "Cash / unit" },
      ], rows: draft.dividends.map((dividend) => ({ ...dividend })) }] : []),
      ...(valuation ? [{ title: "Valuation", entries: [
        metric("Value / unit", valuation.price), metric("Delta", valuation.delta), metric("Gamma", valuation.gamma),
        metric("Theta / day", valuation.thetaPerDay), metric("Vega / vol point", valuation.vegaPerPoint),
        metric("Rho / rate point", valuation.rhoPerPoint),
        ...(draft.marketPrice > 0 ? [{ label: "Implied volatility", value: implied.volatility,
          formatted: implied.volatility == null ? implied.note ?? "Unavailable" : `${number(implied.volatility * 100)}%` }] : []),
      ] }] : []),
    ],
    complete: valuation !== null && errors.length === 0,
    errors, unavailableSymbols: surface?.error && draft.symbol ? [draft.symbol] : [],
    metadata: { model, inputs: draft, valuation, impliedVolatility: implied, surface, effectiveTreeSteps,
      warnings: surface?.warnings ?? [], method: model === "american" ? "CRR American tree with discrete cash dividends" : "European Black-Scholes",
      greekUnits: { delta: "underlying units per option unit", gamma: "delta per underlying price unit", theta: "currency per calendar day",
        vega: "currency per 1 percentage point of volatility", rho: "currency per 1 percentage point of annual rate" },
      methodology: "docs/research-data.md#options-valuation-models" },
  };
}

export const optionsCalculatorHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "none" }, describe: "OVME option valuation",
  discovery: { limitations: ["Discrete dividends use days from valuation and cash per underlying unit; model values exclude fees and assignment costs."] },
  options: [
    { key: "model", type: "enum", values: [{ value: "european" }, { value: "american" }], defaultValue: "european", description: "European closed form or American CRR tree" },
    { key: "side", type: "enum", values: [{ value: "call" }, { value: "put" }], defaultValue: "call", description: "Option side" },
    { key: "symbol", type: "string", description: "Underlying ticker, required for OVDV volatility" },
    { key: "spot", type: "string", defaultValue: "100", description: "Underlying scenario price" },
    { key: "strike", type: "string", defaultValue: "100", description: "Strike price" },
    { key: "days", type: "string", defaultValue: "30", description: "Calendar days to expiry, including fractional days" },
    { key: "volatility", type: "string", defaultValue: "25", description: "Annual volatility, percent" },
    { key: "rate", type: "string", defaultValue: "4", description: "Continuously compounded annual risk-free rate, percent" },
    { key: "dividendYield", aliases: ["dividend-yield"], type: "string", defaultValue: "0", description: "Continuous annual dividend yield, percent" },
    { key: "dividends", type: "string", defaultValue: "", description: "Discrete cash dividends as days:amount separated by semicolons" },
    { key: "steps", type: "integer", minimum: 1, maximum: 2000, defaultValue: 400, description: "Requested CRR time steps" },
    { key: "volSource", aliases: ["vol-source"], type: "enum", values: [{ value: "input" }, { value: "surface" }], defaultValue: "input", description: "Entered volatility or current OVDV surface" },
    { key: "marketPrice", aliases: ["market-price"], type: "string", description: "Observed premium per unit for implied volatility inversion" },
  ],
  async load(args, ctx) {
    const draft = draftFromCalculatorInputs({ ...ctx.settings, ...args.options });
    const dividends = draft.dividends ?? [];
    if (draft.pricingModel !== "american" && dividends.some((dividend) => dividend.amount > 0)) {
      throw new Error("Discrete cash dividends require the American CRR model.");
    }
    let surface: CalculatorSurfaceVol | null = null;
    let valuedDraft = draft;
    if (draft.volSource === "surface") {
      if (!draft.symbol) throw new Error("Surface volatility requires --symbol.");
      const parsed = parsePublicTickerKey(draft.symbol);
      const instrument = await ctx.resolveInstrument?.(draft.symbol) ?? parsed;
      surface = await loadCalculatorSurfaceVol({ symbol: parsed.symbol, exchange: parsed.exchange ?? instrument.exchange,
        spot: draft.spot, strike: draft.strike, daysToExpiry: draft.daysToExpiry, signal: ctx.signal,
      }, createCalculatorSurfaceDependencies(ctx.marketData, ctx.apiClient));
      if (surface.volatility == null || surface.error) return report(draft, null,
        { volatility: null, note: "Surface volatility unavailable" }, surface, [surface.error ?? "Surface volatility unavailable"]);
      valuedDraft = { ...draft, volatility: surface.volatility };
    }
    ctx.signal.throwIfAborted();
    const tree = { exercise: "american" as const, steps: valuedDraft.steps ?? 400, dividends };
    const valuation = valuedDraft.pricingModel === "american" ? valueBinomialOption(valuedDraft, tree) : valueOption(valuedDraft);
    const effectiveTreeSteps = valuedDraft.pricingModel === "american" ? effectiveBinomialSteps(valuedDraft, tree) : null;
    const implied = valuedDraft.marketPrice > 0 ? valuedDraft.pricingModel === "american"
      ? solveBinomialImpliedVolatility(valuedDraft, valuedDraft.marketPrice, tree)
      : solveImpliedVolatility(valuedDraft, valuedDraft.marketPrice) : { volatility: null, note: null };
    return report(valuedDraft, valuation, implied, surface, [], effectiveTreeSteps);
  },
};
