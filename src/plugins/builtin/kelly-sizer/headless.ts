import type { HeadlessPaneDefinition, HeadlessPaneRow } from "../../../types/headless";
import { resolveHeadlessInstrument } from "../shared/headless-market-data";
import { MarketDataCoordinator, resolveEntryValue } from "../../../market-data/coordinator";
import { parseHedgeAmount } from "../options-scenario/hedge";
import { clipPriceHistoryToRange } from "../../../time-series/history-window";
import { formatNumber } from "../../../utils/format";
import { buildBinaryOutcomes, solveKellyFraction } from "./model";
import {
  clampKellyHistoryYears,
  estimateKellyHistoryInputs,
  KELLY_HISTORY_DEFAULT_YEARS,
  KELLY_HISTORY_MAX_YEARS,
  KELLY_HISTORY_MIN_PERIODS,
  kellyHistoryRange,
  kellyHistoryRequest,
  type KellyHistoryInputs,
} from "./history";
import { formatPct, formatSignedPct } from "./view";

/** The fractions of full Kelly a report sizes, largest first. */
const KELLY_FRACTIONS = [
  { id: "full", label: "Full Kelly", fraction: 1 },
  { id: "half", label: "Half Kelly", fraction: 0.5 },
  { id: "quarter", label: "Quarter Kelly", fraction: 0.25 },
] as const;

/** The inputs a ticker's monthly returns give, as the History tab shows them. */
function inputEntries(inputs: KellyHistoryInputs, edge: number) {
  const payoff = inputs.downsideReturn < 0 ? inputs.upsideReturn / -inputs.downsideReturn : null;
  return [
    { key: "window", label: "Window", value: { start: inputs.start, end: inputs.end, months: inputs.periods },
      formatted: `${inputs.start} to ${inputs.end}, ${inputs.periods} monthly returns` },
    { key: "winRate", label: "Win rate", value: inputs.winProbability,
      formatted: `${formatPct(inputs.winProbability)} (${inputs.wins} of ${inputs.periods} months up)` },
    { key: "averageGain", label: "Average gain", value: inputs.upsideReturn, formatted: `${formatSignedPct(inputs.upsideReturn)} a month` },
    { key: "averageLoss", label: "Average loss", value: inputs.downsideReturn, formatted: `${formatSignedPct(inputs.downsideReturn)} a month` },
    { key: "payoffRatio", label: "Payoff ratio", value: payoff, formatted: payoff == null ? "no down month" : `${formatNumber(payoff, 2)}x` },
    { key: "edge", label: "Edge", value: edge, formatted: `${formatSignedPct(edge)} a month` },
  ];
}

export const kellyHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  argument: { kind: "ticker", description: "Ticker to size" },
  freshness: { source: "Your inputs and Gloom Cloud", status: "not-a-feed", basis: "monthly returns from daily closes", cadence: "daily", oldest: null },
  description: "Kelly sizing for a ticker from its own monthly returns: win rate, payoff ratio and edge over a lookback, then full, half and quarter Kelly as a share of a bankroll.",
  describe: (args) => `Kelly sizing | ${args.symbols[0] ?? ""}`,
  discovery: {
    dataRequirements: ["Gloom Cloud daily closes over the lookback, and the latest quote for share counts"],
    limitations: ["Win rate, gain and loss are the ticker's own non-overlapping 21-session returns; past months are not a forecast."],
  },
  options: [
    {
      key: "bankroll",
      type: "string",
      settingKey: "bankroll",
      placeholder: "amount",
      example: "--bankroll 250000",
      description: "Bankroll in your base currency, such as 250000, 250k or 1.5m; sizes each Kelly fraction in money.",
      normalize: (value) => parseHedgeAmount(value, "bankroll"),
    },
    {
      key: "years",
      type: "integer",
      settingKey: "historyYears",
      minimum: 1,
      maximum: KELLY_HISTORY_MAX_YEARS,
      defaultValue: KELLY_HISTORY_DEFAULT_YEARS,
      description: "Lookback in years for the monthly returns.",
    },
  ],
  async load(args, ctx) {
    const { symbol, exchange = "" } = await resolveHeadlessInstrument(ctx, args.symbols[0]!);
    const years = clampKellyHistoryYears(args.options.years);
    const range = kellyHistoryRange(years);
    // The quote and the one history window the lookback needs load together, through the
    // coordinator every chart reads daily closes from (the History tab's request, cache included).
    const [entry, quote] = await Promise.all([
      new MarketDataCoordinator(ctx.marketData).loadChart(kellyHistoryRequest({ symbol, exchange }, years), { forceRefresh: ctx.refresh }),
      ctx.marketData.getQuote(symbol, exchange, ctx.refresh ? { cacheMode: "refresh" } : undefined).catch(() => null),
    ]);
    const history = clipPriceHistoryToRange(resolveEntryValue(entry) ?? [], range);
    ctx.signal.throwIfAborted();
    const inputs = estimateKellyHistoryInputs(history, years);
    if (!inputs) {
      return {
        complete: false,
        unavailableSymbols: [symbol],
        errors: [`${symbol}: fewer than ${KELLY_HISTORY_MIN_PERIODS} monthly returns in the last ${years} year${years === 1 ? "" : "s"}.`],
        sections: [],
      };
    }
    const solve = solveKellyFraction(buildBinaryOutcomes(inputs.winProbability, inputs.upsideReturn, inputs.downsideReturn));
    const bankrollValue = args.options.bankroll;
    const bankroll = typeof bankrollValue === "number" && bankrollValue > 0 ? bankrollValue : null;
    const baseCurrency = ctx.config.baseCurrency || "USD";
    const price = quote && quote.price > 0 && Number.isFinite(quote.price) ? quote.price : null;
    // Shares only when the bankroll and the price are in one currency.
    const sharePrice = price != null && quote?.currency === baseCurrency ? price : null;
    const rows: HeadlessPaneRow[] = KELLY_FRACTIONS.map(({ id, label, fraction }) => {
      const share = solve.fraction * fraction;
      const position = bankroll == null ? null : share * bankroll;
      return {
        id,
        kelly: label,
        fraction: share,
        position,
        shares: position != null && sharePrice != null ? Math.floor(position / sharePrice) : null,
      };
    });
    const notes = [
      ...(solve.warning ? [solve.warning] : []),
      ...(solve.fraction === 0 ? ["No positive edge over this window: every Kelly fraction sizes nothing."] : []),
      ...(bankroll == null ? [`Add --bankroll <amount> to size each fraction in ${baseCurrency}.`] : []),
    ];
    return {
      complete: true,
      freshness: { asOf: inputs.end },
      notes,
      sections: [
        { title: "Inputs", entries: inputEntries(inputs, solve.expectedReturn) },
        {
          title: bankroll == null ? "Sizing" : `Sizing on ${formatNumber(bankroll, 0)} ${baseCurrency}`,
          columns: [
            { key: "kelly", header: "Kelly" },
            { key: "fraction", header: "% of bankroll", align: "right", format: (value) => typeof value === "number" ? formatPct(value, 2) : "--" },
            ...(bankroll == null ? [] : [
              { key: "position", header: `Position ${baseCurrency}`, align: "right" as const,
                format: (value: unknown) => typeof value === "number" ? formatNumber(value, 0) : "--" },
              ...(sharePrice == null ? [] : [{ key: "shares", header: "Shares", align: "right" as const,
                format: (value: unknown) => typeof value === "number" ? formatNumber(value, 0) : "--" }]),
            ]),
          ],
          rows,
        },
      ],
      metadata: {
        symbol,
        inputs,
        expectedReturn: solve.expectedReturn,
        expectedLogGrowth: solve.expectedLogGrowth,
        bankroll,
        currency: baseCurrency,
        price: price == null ? null : { value: price, currency: quote?.currency ?? null, asOf: quote?.lastUpdated ?? null },
        method: "Binary Kelly on non-overlapping 21-session returns: win rate, mean gain and mean loss.",
      },
    };
  },
};
