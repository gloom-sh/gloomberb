import { numberErrorMessage } from "../../../utils/decimal-comma";
import { priceBond, solveBondYield, treasurySpread, type BondTerms, type TreasuryBenchmarkPoint } from "./math";

export interface BondDraft {
  settlement: string;
  maturity: string;
  coupon: string;
  quote: string;
  mode: "yield" | "price";
  frequency: string;
  dayCount: string;
  endOfMonth: boolean;
}

export function defaultBondDraft(now = new Date()): BondDraft {
  const settlement = now.toISOString().slice(0, 10);
  const maturity = new Date(now);
  maturity.setUTCFullYear(maturity.getUTCFullYear() + 5);
  return { settlement, maturity: maturity.toISOString().slice(0, 10), coupon: "5", quote: "4.25", mode: "yield",
    frequency: "2", dayCount: "act-act-icma", endOfMonth: false };
}

/**
 * A coupon or yield typed with a decimal comma (`3,875`, `-0,25`) reads as the
 * decimal it is: a percent rate is never in the thousands, so `3,875` is
 * 3.875%, not 3875. A clean price keeps the dot it is told to use.
 */
const DECIMAL_COMMA_RATE = /^([+-]?\d+),(\d+)$/;

function inputNumber(value: string, label: string, decimalComma = false): number {
  const comma = decimalComma ? DECIMAL_COMMA_RATE.exec(value.trim()) : null;
  const text = comma ? `${comma[1]}.${comma[2]}` : value.trim();
  if (!text || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) throw new Error(numberErrorMessage(`${label} must be a number`, value));
  const number = Number(text);
  if (!Number.isFinite(number)) throw new Error(`${label} must be finite`);
  return number;
}

export function calculateBond(draft: BondDraft, curve: readonly TreasuryBenchmarkPoint[] = []) {
  if (!["yield", "price"].includes(draft.mode)) throw new Error("Select price or yield input");
  const terms: BondTerms = { settlement: draft.settlement, maturity: draft.maturity, couponPercent: inputNumber(draft.coupon, "Coupon", true),
    frequency: Number(draft.frequency) as BondTerms["frequency"], dayCount: draft.dayCount as BondTerms["dayCount"], endOfMonth: draft.endOfMonth };
  const quote = draft.mode === "yield" ? inputNumber(draft.quote, "Yield", true) : inputNumber(draft.quote, "Clean price");
  const yieldPercent = draft.mode === "yield" ? quote : solveBondYield(terms, quote);
  const analytics = priceBond(terms, yieldPercent);
  const spread = treasurySpread(terms, yieldPercent, curve);
  const sensitivity = [-100, -50, -25, 0, 25, 50, 100].map((shiftBps) => {
    const shockedYield = yieldPercent + shiftBps / 100;
    try {
      const price = priceBond(terms, shockedYield).cleanPrice;
      return { shiftBps, yieldPercent: shockedYield, cleanPrice: price, priceChange: price - analytics.cleanPrice,
        returnPercent: (price - analytics.cleanPrice) / analytics.dirtyPrice * 100 };
    } catch {
      return { shiftBps, yieldPercent: shockedYield, cleanPrice: null, priceChange: null, returnPercent: null };
    }
  });
  return { terms, analytics, spread, sensitivity };
}

export function bondDraftFromOptions(options: Record<string, unknown>, now = new Date()): BondDraft {
  const draft = defaultBondDraft(now);
  for (const key of ["settlement", "maturity", "coupon", "frequency", "dayCount"] as const) {
    if (options[key] != null) draft[key] = String(options[key]);
  }
  if (options.price != null && options.yield != null) throw new Error("Provide price or yield, not both");
  if (options.price != null) { draft.mode = "price"; draft.quote = String(options.price); }
  if (options.yield != null) draft.quote = String(options.yield);
  if (options.endOfMonth != null) {
    if (typeof options.endOfMonth !== "boolean") throw new Error("End of month must be a boolean");
    draft.endOfMonth = options.endOfMonth;
  }
  return draft;
}
