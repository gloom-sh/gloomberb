import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { loadBondBenchmark } from "./client";
import { bondDraftFromOptions, calculateBond } from "./model";

export const bondCalculatorHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  argument: { kind: "none" },
  describe: "Bond Calculator",
  options: [
    { key: "settlement", type: "string", description: "Settlement date YYYY-MM-DD; defaults to today", settingKey: "settlement" },
    { key: "maturity", type: "string", description: "Maturity date YYYY-MM-DD; defaults to five years from today", settingKey: "maturity" },
    { key: "coupon", type: "string", description: "Annual coupon percent; defaults to 5", settingKey: "coupon" },
    { key: "yield", type: "string", description: "Yield percent to calculate clean price; defaults to 4.25", settingKey: "yield" },
    { key: "price", type: "string", description: "Clean price per 100 face to solve yield", settingKey: "price" },
    { key: "frequency", type: "enum", values: [{ value: "1" }, { value: "2" }, { value: "4" }], defaultValue: "2", description: "Coupons per year", settingKey: "frequency" },
    { key: "dayCount", aliases: ["day-count"], type: "enum", values: [{ value: "act-act-icma" }, { value: "30-360-us" }], defaultValue: "act-act-icma", description: "Coupon day-count convention", settingKey: "dayCount" },
    { key: "endOfMonth", aliases: ["end-of-month"], type: "boolean", defaultValue: false, description: "Anchor coupons to month end", settingKey: "endOfMonth" },
    { key: "tab", type: "enum", values: [{ value: "valuation" }, { value: "cashflows" }, { value: "sensitivity" }], defaultValue: "valuation", description: "Initial pane view", settingKey: "tab" },
  ],
  async load(args, context) {
    const draft = bondDraftFromOptions(args.options);
    // Validate inputs before starting an optional network request.
    const calculation = calculateBond(draft);
    let benchmark;
    const errors: string[] = [];
    try { benchmark = await loadBondBenchmark(() => context.apiClient.getCloudYieldCurve()); }
    catch (error) { errors.push(`Treasury curve: ${error instanceof Error ? error.message : String(error)}`); }
    const result = benchmark ? calculateBond(draft, benchmark.points) : calculation;
    errors.push(...benchmark?.notices ?? []);
    if (!result.spread) errors.push("Treasury spread unavailable: matching dated tenors must bracket the remaining maturity.");
    const a = result.analytics;
    return {
      complete: errors.length === 0,
      errors,
      metadata: { settlement: draft.settlement, terms: result.terms, source: "Manual bond inputs; Treasury par yields via Gloom Cloud / FRED",
        treasuryAsOf: result.spread?.asOf ?? null, percentile: null, percentileReason: "Hypothetical bond has no historical sample", units: "Prices and DV01 per 100 face", mode: draft.mode },
      sections: [
        { title: `Valuation at ${draft.settlement}`, entries: [
          { label: "Clean price", value: a.cleanPrice, formatted: a.cleanPrice.toFixed(4) },
          { label: "Yield", value: a.yieldPercent, formatted: `${a.yieldPercent.toFixed(4)}%` },
          { label: "Accrued interest", value: a.accruedInterest, formatted: a.accruedInterest.toFixed(4) },
          { label: "Dirty price", value: a.dirtyPrice, formatted: a.dirtyPrice.toFixed(4) },
          { label: "Macaulay duration", value: a.macaulayDuration, formatted: `${a.macaulayDuration.toFixed(4)} years` },
          { label: "Modified duration", value: a.modifiedDuration, formatted: `${a.modifiedDuration.toFixed(4)} years` },
          { label: "Convexity", value: a.convexity, formatted: a.convexity.toFixed(4) },
          { label: "DV01", value: a.dv01, formatted: a.dv01.toFixed(6) },
          { label: "Treasury spread", value: result.spread?.spreadBps ?? null, formatted: result.spread ? `${result.spread.spreadBps.toFixed(1)} bp as of ${result.spread.asOf}` : "Unavailable" },
        ] },
        { title: "Cash flows per 100 face", columns: [{ key: "date", header: "Payment" }, { key: "amount", header: "Cash", format: (n) => Number(n).toFixed(4) }, { key: "presentValue", header: "Present value", format: (n) => Number(n).toFixed(4) }], rows: a.cashFlows.map((flow) => ({ ...flow })) },
        { title: "Yield sensitivity", columns: [{ key: "shiftBps", header: "Shift bp" }, { key: "yieldPercent", header: "Yield %" }, { key: "cleanPrice", header: "Clean price", format: (n) => n == null ? "-" : Number(n).toFixed(4) }, { key: "priceChange", header: "Change", format: (n) => n == null ? "-" : Number(n).toFixed(4) }], rows: result.sensitivity },
      ],
    };
  },
};
