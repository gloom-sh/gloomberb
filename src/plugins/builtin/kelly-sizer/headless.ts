import type { HeadlessPaneDefinition, HeadlessPaneRow } from "../../../types/headless";
import { resolveHeadlessInstrument } from "../shared/headless-market-data";
import { MarketDataCoordinator, resolveEntryValue } from "../../../market-data/coordinator";
import { parseHedgeAmount } from "../options-scenario/hedge";
import { convertCurrency, formatNumber } from "../../../utils/format";
import { fxRateCurrencies } from "../../../utils/currency-units";
import { buildBinaryOutcomes, solveKellyFraction } from "./model";
import {
  clampKellyHistoryYears,
  estimateKellyHistoryInputs,
  KELLY_HISTORY_DEFAULT_YEARS,
  KELLY_HISTORY_MAX_YEARS,
  KELLY_HISTORY_MIN_PERIODS,
  kellyHistoryRequest,
  kellyTrailingHistoryRequest,
  type KellyHistoryInputs,
} from "./history";
import { historyReadUnanswered } from "../../../time-series/calendar-month-returns";
import { formatPct, formatSignedPct } from "./view";
import { logFailure } from "../../../utils/log-failure";
import { loadFuturesContractTerms } from "../../../market-data/futures-contract";
import { kellyCount, kellyCountMultiplier, type KellyCount } from "./units";

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
      formatted: `${inputs.start} to ${inputs.end}, ${inputs.periods} monthly returns${inputs.rollNote ? `, ${inputs.rollNote}` : ""}` },
    { key: "winRate", label: "Win rate", value: inputs.winProbability,
      formatted: `${formatPct(inputs.winProbability)} (${inputs.wins} of ${inputs.periods} months up)` },
    { key: "averageGain", label: "Average gain", value: inputs.upsideReturn, formatted: `${formatSignedPct(inputs.upsideReturn)} a month` },
    { key: "averageLoss", label: "Average loss", value: inputs.downsideReturn, formatted: `${formatSignedPct(inputs.downsideReturn)} a month` },
    { key: "payoffRatio", label: "Payoff ratio", value: payoff, formatted: payoff == null ? "no down month" : `${formatNumber(payoff, 2)}x` },
    { key: "edge", label: "Edge", value: edge, formatted: `${formatSignedPct(edge)} a month` },
  ];
}

const COUNT_HEADER: Record<KellyCount, string> = { shares: "Shares", units: "Units", contracts: "Contracts" };

/**
 * `price` in the base currency at the rates the portfolio values holdings at
 * (USD per unit, from the same FX store); null when either rate is missing.
 */
async function priceInBase(price: number, currency: string | undefined, baseCurrency: string, coordinator: MarketDataCoordinator): Promise<number | null> {
  if (!currency) return null;
  if (currency === baseCurrency) return price;
  const rates = new Map([["USD", 1]]);
  await Promise.all(fxRateCurrencies([currency, baseCurrency]).filter((code) => code !== "USD").map(async (code) => {
    const entry = await coordinator.loadFxRate(code).catch(logFailure("kelly-sizer.headless", "Load the exchange rate for Kelly units failed", null));
    const rate = entry ? resolveEntryValue(entry) : null;
    if (rate != null) rates.set(code, rate);
  }));
  const converted = convertCurrency(price, currency, baseCurrency, rates);
  return Number.isFinite(converted) && converted > 0 ? converted : null;
}

export const kellyHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  argument: { kind: "ticker", description: "Ticker to size" },
  freshness: { source: "Your inputs and Gloom Cloud", status: "not-a-feed", basis: "monthly returns from daily closes", cadence: "daily", oldest: null },
  description: "Kelly sizing for a ticker from its own monthly returns: win rate, payoff ratio and edge over a lookback, then full, half and quarter Kelly as a share of a bankroll.",
  describe: (args) => `Kelly sizing | ${args.symbols[0] ?? ""}`,
  discovery: {
    dataRequirements: ["Gloom Cloud daily closes over the lookback, the latest quote for share or unit counts, and the exchange rate to the base currency"],
    limitations: ["Win rate, gain and loss are the ticker's own calendar-month returns, month-end close to month-end close; past months are not a forecast."],
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
    // The quote and the one history window the lookback needs load together, through the
    // coordinator every chart reads daily closes from (the History tab's request, cache included).
    const coordinator = new MarketDataCoordinator(ctx.marketData);
    const loadHistory = async () => {
      const dated = await coordinator.loadChart(kellyHistoryRequest({ symbol, exchange }, years), { forceRefresh: ctx.refresh });
      // A source with no dated history answers from its trailing range, as the History tab does.
      return historyReadUnanswered(dated)
        ? coordinator.loadChart(kellyTrailingHistoryRequest({ symbol, exchange }, years), { forceRefresh: ctx.refresh })
        : dated;
    };
    const [entry, quote] = await Promise.all([
      loadHistory(),
      ctx.marketData.getQuote(symbol, exchange, ctx.refresh ? { cacheMode: "refresh" } : undefined).catch(logFailure("kelly-sizer.headless", "Load Kelly sizing quote failed", null)),
    ]);
    const history = resolveEntryValue(entry) ?? [];
    ctx.signal.throwIfAborted();
    const inputs = estimateKellyHistoryInputs(history, years, { exchange, symbol });
    if (!inputs) {
      return {
        complete: false,
        unavailableSymbols: [symbol],
        errors: [`${symbol}: need at least ${KELLY_HISTORY_MIN_PERIODS} monthly returns, including a gain and a loss, in the last ${years} year${years === 1 ? "" : "s"}.`],
        sections: [],
      };
    }
    const solve = solveKellyFraction(buildBinaryOutcomes(inputs.winProbability, inputs.upsideReturn, inputs.downsideReturn));
    const bankrollValue = args.options.bankroll;
    const bankroll = typeof bankrollValue === "number" && bankrollValue > 0 ? bankrollValue : null;
    const baseCurrency = ctx.config.baseCurrency || "USD";
    const price = quote && quote.price > 0 && Number.isFinite(quote.price) ? quote.price : null;
    // A future is counted in contracts, each its price times the contract's multiplier.
    const count = kellyCount(symbol, exchange, quote?.instrumentType);
    const [multiplier, basePrice] = bankroll == null || price == null ? [null, null] : await Promise.all([
      kellyCountMultiplier(symbol, count, (key) => loadFuturesContractTerms(key, ctx.apiClient)),
      // The price in the bankroll's currency, at the rate the portfolio values holdings at; null without one.
      priceInBase(price, quote?.currency, baseCurrency, coordinator),
    ]);
    const unitPrice = basePrice == null || multiplier == null ? null : basePrice * multiplier;
    // A coin is divisible and sized to a hundredth; shares and contracts whole.
    const coin = count === "units";
    const units = COUNT_HEADER[count];
    const rows: HeadlessPaneRow[] = KELLY_FRACTIONS.map(({ id, label, fraction }) => {
      const share = solve.fraction * fraction;
      const position = bankroll == null ? null : share * bankroll;
      const held = position != null && unitPrice != null ? position / unitPrice : null;
      return {
        id,
        kelly: label,
        fraction: share,
        position,
        shares: held == null ? null : coin ? Math.floor(held * 100) / 100 : Math.floor(held),
      };
    });
    // A fraction over the whole bankroll is a levered position.
    const levered = rows.filter((row) => (row.fraction as number) > 1)
      .map((row) => `${row.kelly} ${formatPct(row.fraction as number, 2)} is ${(row.fraction as number).toFixed(2)}x the bankroll`);
    const notes = [
      ...(solve.warning ? [solve.warning] : []),
      ...(levered.length ? [`Over 100% of bankroll means leverage, borrowing or margin beyond what you hold: ${levered.join(", ")}.`] : []),
      ...(solve.fraction === 0 ? ["No positive edge over this window: every Kelly fraction sizes nothing."] : []),
      ...(bankroll == null ? [`Add --bankroll <amount> to size each fraction in ${baseCurrency}.`] : []),
      ...(bankroll != null && price != null && multiplier == null
        ? [`No contract size for ${symbol} to count contracts in: each position is in ${baseCurrency} only.`]
        : bankroll != null && price != null && basePrice == null
          ? [`No ${quote?.currency || "quote"} to ${baseCurrency} rate to count ${count} in: each position is in ${baseCurrency} only.`]
          : []),
    ];
    return {
      complete: true,
      // Dated by the newest close read: the months stop at the last one that has ended.
      freshness: { asOf: inputs.latest },
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
              ...(unitPrice == null ? [] : [{ key: "shares", header: units, align: "right" as const,
                format: (value: unknown) => typeof value === "number" ? formatNumber(value, coin ? 2 : 0) : "--" }]),
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
        ...(basePrice != null && quote?.currency !== baseCurrency ? { priceInBase: { value: basePrice, currency: baseCurrency } } : {}),
        ...(count === "contracts" && multiplier != null ? { contractMultiplier: multiplier } : {}),
        units: count,
        method: "Binary Kelly on calendar-month returns, month-end close to month-end close: win rate, mean gain and mean loss.",
      },
    };
  },
};
