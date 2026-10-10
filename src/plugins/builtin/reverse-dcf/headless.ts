import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { formatCompactCurrency } from "../../../utils/format";
import { resolveHeadlessInstrument } from "../shared/headless-market-data";
import { loadReverseDcfInputs } from "./client";
import { DISCOUNT_RATES, projectReverseDcf, TERMINAL_GROWTH, TERMINAL_GROWTHS, type ImpliedGrowth } from "./model";

const percent = (value: unknown) => typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "--";
const implied = (value: ImpliedGrowth | null) => !value ? null : value.kind === "rate" ? value.value : value.kind;

export const reverseDcfHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "ticker", description: "Ticker" },
  freshness: { status: "not-a-feed", basis: "price and reported cash flows" },
  describe: (args) => `RDCF ${args.symbols[0] ?? ""}`,
  discovery: { screenshotReadiness: "live-dom", limitations: ["Trailing twelve-month free cash flow against the reported enterprise value."] },
  options: [
    { key: "discountRate", type: "integer", minimum: 7, maximum: 12, defaultValue: 9, description: "Discount rate in percent" },
  ],
  async load(args, ctx) {
    const instrument = await resolveHeadlessInstrument(ctx, args.symbols[0]!);
    const inputs = await loadReverseDcfInputs({ instrument, signal: ctx.signal }, ctx.marketData);
    ctx.signal.throwIfAborted();
    const discountRate = (Number(args.options.discountRate) || 9) / 100;
    const model = projectReverseDcf(inputs.financials, { symbol: instrument.symbol, discountRate });
    return {
      sections: [
        { title: "Reverse DCF", columns: [{ key: "label", header: "" }, { key: "value", header: "Value" }], rows: [
          { label: "Implied FCF growth, 10 years", value: typeof implied(model.implied) === "number" ? percent(implied(model.implied)) : implied(model.implied) ?? "--" },
          { label: "Past FCF growth", value: model.pastGrowth ? `${percent(model.pastGrowth.rate)} over ${model.pastGrowth.years}y` : "--" },
          { label: "FCF yield", value: percent(model.fcfYield) },
          { label: "Enterprise value", value: formatCompactCurrency(model.enterpriseValue ?? undefined, model.currency ?? undefined) },
          { label: "Free cash flow, TTM", value: formatCompactCurrency(model.freeCashFlow ?? undefined, model.currency ?? undefined) },
        ] },
        { title: "Implied growth by discount rate and terminal growth", columns: [{ key: "discountRate", header: "Discount", format: percent },
          ...TERMINAL_GROWTHS.map((terminal, index) => ({ key: `t${index}`, header: `Terminal ${percent(terminal)}`, format: percent }))],
        rows: model.sensitivity.map((row) => ({ discountRate: row.discountRate,
          ...Object.fromEntries(row.implied.map((value, index) => [`t${index}`, implied(value)])) })) },
      ],
      complete: !inputs.stale && !inputs.error && !model.error,
      ...(inputs.stale ? { freshness: { status: "stale" as const } } : {}),
      unavailableSymbols: model.implied ? [] : [instrument.symbol],
      errors: [inputs.error, model.error].filter((value): value is string => !!value),
      metadata: { currency: model.currency, discountRate, terminalGrowth: TERMINAL_GROWTH, discountRates: DISCOUNT_RATES,
        stale: inputs.stale, fetchedAt: inputs.fetchedAt, methodology: "docs/research-data.md#reverse-dcf" },
    };
  },
};
