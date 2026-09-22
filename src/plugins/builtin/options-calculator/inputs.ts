import { DEFAULT_OPTION_CALC_DRAFT, updateOptionCalcDraft, type OptionCalcDraft } from "./model";
import type { CashDividend } from "./binomial";

const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

function numberInput(value: unknown, label: string): number {
  if (typeof value !== "number" && (typeof value !== "string" || !DECIMAL.test(value.trim()))) {
    throw new Error(`${label} must be a finite number.`);
  }
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`${label} must be a finite number.`);
  return result;
}

/** Cash paid per underlying unit, at calendar days from the valuation time. */
export function parseCashDividends(text: string, daysToExpiry = Number.POSITIVE_INFINITY): CashDividend[] {
  if (typeof text !== "string") throw new Error("Dividends must use days:amount separated by semicolons.");
  if (!(daysToExpiry >= 0)) throw new Error("Days to expiry must be nonnegative.");
  if (!text.trim()) return [];
  return text.split(";").map((entry, index) => {
    const fields = entry.split(":");
    if (fields.length !== 2) throw new Error(`Dividend ${index + 1} needs days:amount.`);
    const days = numberInput(fields[0], `Dividend ${index + 1} days`);
    const amount = numberInput(fields[1], `Dividend ${index + 1} amount`);
    if (days < 0 || days > daysToExpiry) throw new Error(`Dividend ${index + 1} must fall between today and expiry.`);
    if (amount < 0) throw new Error(`Dividend ${index + 1} amount must be nonnegative.`);
    return { days, amount };
  });
}

/** CLI/settings percentages are display units; existing pane params stay decimal. */
export function draftFromCalculatorInputs(settings: Record<string, unknown>, base: OptionCalcDraft = DEFAULT_OPTION_CALC_DRAFT): OptionCalcDraft {
  const patch: Partial<OptionCalcDraft> = {};
  const supplied = (key: string) => settings[key] !== undefined && settings[key] !== null;
  for (const key of ["spot", "strike", "marketPrice"] as const) {
    if (supplied(key)) {
      const value = numberInput(settings[key], key);
      if (value < 0) throw new Error(`${key} must be nonnegative.`);
      patch[key] = value;
    }
  }
  if (supplied("days")) {
    patch.daysToExpiry = numberInput(settings.days, "Days to expiry");
    if (patch.daysToExpiry < 0) throw new Error("Days to expiry must be nonnegative.");
  }
  for (const key of ["volatility", "rate", "dividendYield"] as const) {
    if (supplied(key)) {
      const value = numberInput(settings[key], key) / 100;
      if (key === "volatility" && value < 0) throw new Error("Volatility must be nonnegative.");
      patch[key] = value;
    }
  }
  if (supplied("symbol")) {
    if (typeof settings.symbol !== "string") throw new Error("Symbol must be text.");
    patch.symbol = settings.symbol.trim().toUpperCase();
  }
  if (supplied("side")) {
    if (settings.side !== "call" && settings.side !== "put") throw new Error("Side must be call or put.");
    patch.side = settings.side;
  }
  if (supplied("model")) {
    if (settings.model !== "european" && settings.model !== "american") throw new Error("Model must be european or american.");
    patch.pricingModel = settings.model;
  }
  if (supplied("volSource")) {
    if (settings.volSource !== "input" && settings.volSource !== "surface") throw new Error("Volatility source must be input or surface.");
    patch.volSource = settings.volSource;
  }
  if (supplied("steps")) {
    const steps = numberInput(settings.steps, "Steps");
    if (!Number.isSafeInteger(steps) || steps < 1 || steps > 2000) throw new Error("Steps must be an integer between 1 and 2000.");
    patch.steps = steps;
  }
  if (supplied("dividends")) {
    patch.dividends = parseCashDividends(settings.dividends as string, patch.daysToExpiry ?? base.daysToExpiry);
  }
  return updateOptionCalcDraft(base, patch);
}
