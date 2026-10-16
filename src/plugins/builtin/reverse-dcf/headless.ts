import { getCompletedRegularSessionDisplay } from "../../../market-data/market/status";
import { regularSessionValuationTime } from "../../../market-data/quotes/regular-session-valuation";
import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { formatCompactCurrency } from "../../../utils/format";
import { resolveHeadlessInstrument } from "../shared/headless-market-data";
import { loadReverseDcfInputs } from "./client";
import { DEFAULT_FCF_MARGIN, DISCOUNT_RATES, projectReverseDcf, TERMINAL_GROWTH, TERMINAL_GROWTHS, type ImpliedGrowth } from "./model";

const percent = (value: unknown) => typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "--";
/** An assumption as it is set: 9%, 2.5%. */
const rate = (value: number) => `${Number((value * 100).toFixed(2))}%`;
const implied = (value: ImpliedGrowth | null) => !value ? null : value.kind === "rate" ? value.value : value.kind;

export const reverseDcfHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "ticker", description: "Ticker" },
  freshness: { status: "not-a-feed", basis: "price and reported cash flows" },
  describe: (args) => `RDCF ${args.symbols[0] ?? ""}`,
  discovery: { screenshotReadiness: "live-dom", limitations: ["Trailing twelve-month free cash flow against the reported enterprise value."] },
  options: [
    { key: "discountRate", type: "integer", minimum: 7, maximum: 12, defaultValue: 9, description: "Discount rate in percent" },
    { key: "margin", type: "integer", minimum: 5, maximum: 60, defaultValue: Math.round(DEFAULT_FCF_MARGIN * 100),
      description: "Free cash flow margin in percent behind the implied year-10 revenue" },
  ],
  async load(args, ctx) {
    const instrument = await resolveHeadlessInstrument(ctx, args.symbols[0]!);
    const inputs = await loadReverseDcfInputs({ instrument, signal: ctx.signal }, ctx.marketData);
    ctx.signal.throwIfAborted();
    const discountRate = (Number(args.options.discountRate) || 9) / 100;
    const fcfMargin = (Number(args.options.margin) || DEFAULT_FCF_MARGIN * 100) / 100;
    const model = projectReverseDcf(inputs.financials, { symbol: instrument.symbol, discountRate, fcfMargin });
    const growth = implied(model.implied);
    const currency = model.currency ?? undefined;
    const quote = inputs.financials?.quote;
    // The enterprise value is measured at the regular session price, so the report is dated by it: after the close, the close.
    const valuedAt = regularSessionValuationTime(quote);
    return {
      sections: [
        { title: "Reverse DCF", columns: [{ key: "label", header: "" }, { key: "value", header: "Value" }], rows: [
          { label: "Implied FCF growth, 10 years", value: growth == null ? "--"
            : `${typeof growth === "number" ? percent(growth) : growth} at ${rate(discountRate)} discount, ${rate(TERMINAL_GROWTH)} terminal` },
          { label: "Implied revenue, year 10", value: model.impliedRevenue == null ? "--"
            : `${formatCompactCurrency(model.impliedRevenue, currency)} at ${rate(fcfMargin)} FCF margin` },
          { label: "Past FCF growth", value: model.pastGrowth ? `${percent(model.pastGrowth.rate)} over ${model.pastGrowth.years}y` : "--" },
          { label: "FCF yield", value: percent(model.fcfYield) },
          { label: "Enterprise value", value: `${formatCompactCurrency(model.enterpriseValue ?? undefined, currency)}${model.enterpriseValueNote ? " (provider)" : ""}` },
          { label: "Free cash flow, TTM", value: formatCompactCurrency(model.freeCashFlow ?? undefined, currency) },
        ] },
        { title: "Implied growth by discount rate and terminal growth", columns: [{ key: "discountRate", header: "Discount", format: percent },
          ...TERMINAL_GROWTHS.map((terminal, index) => ({ key: `t${index}`, header: `Terminal ${percent(terminal)}`, format: percent }))],
        rows: model.sensitivity.map((row) => ({ discountRate: row.discountRate,
          ...Object.fromEntries(row.implied.map((value, index) => [`t${index}`, implied(value)])) })) },
      ],
      complete: !inputs.stale && !inputs.error && !model.error,
      freshness: {
        asOf: valuedAt ? (valuedAt.dateOnly ? new Date(valuedAt.time).toISOString().slice(0, 10) : valuedAt.time) : null,
        ...(getCompletedRegularSessionDisplay(quote) ? { basis: "regular close and reported cash flows" } : {}),
        ...(inputs.stale ? { status: "stale" as const } : {}),
      },
      unavailableSymbols: model.implied ? [] : [instrument.symbol],
      errors: [inputs.error, model.error].filter((value): value is string => !!value),
      ...(model.enterpriseValueNote ? { notes: [model.enterpriseValueNote] } : {}),
      metadata: { currency: model.currency, discountRate, terminalGrowth: TERMINAL_GROWTH, discountRates: DISCOUNT_RATES, fcfMargin,
        impliedRevenue: model.impliedRevenue, stale: inputs.stale, fetchedAt: inputs.fetchedAt, methodology: "docs/research-data.md#reverse-dcf" },
    };
  },
};
