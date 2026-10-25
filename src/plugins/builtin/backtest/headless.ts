import type { HeadlessPaneContext, HeadlessPaneDefinition } from "../../../types/headless";
import type { InstrumentRef } from "../../../market-data/request-types";
import { DATE_OPTION_EXAMPLES, isoDateOption } from "../../../utils/calendar-date";
import { resolveHeadlessInstrument } from "../shared/headless-market-data";
import { createBacktestDependencies, loadBacktestHistory } from "./client";
import { BACKTEST_PRESETS, CUSTOM_PRESET_ID, DEFAULT_PRESET, lookbackYears, presetRulesConflict, resolveRules } from "./presets";
import { BACKTEST_FRESHNESS, backtestPriceUnit, backtestReport } from "./report";
import { parseRule, RULE_SYNTAX } from "./rules";
import { runHistoryBacktest } from "./window";

/** The listing's price unit, as `history` reads it from the quote; null when no quote says. */
async function priceUnit(ctx: HeadlessPaneContext, instrument: InstrumentRef): Promise<string | null> {
  try {
    const quote = ctx.marketData.getQuoteMetadata
      ? await ctx.marketData.getQuoteMetadata(instrument.symbol, instrument.exchange)
      : await ctx.marketData.getQuote(instrument.symbol, instrument.exchange);
    return backtestPriceUnit(instrument.symbol, quote);
  } catch {
    // Intentional ignore: without a quote the rows stay unlabelled, as `history` leaves them.
    return backtestPriceUnit(instrument.symbol, null);
  }
}

export const backtestHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  freshness: BACKTEST_FRESHNESS,
  // The sessions a run leaves out stay with a saved curve, not only on stderr.
  exportWarnings: true,
  argument: { kind: "ticker", description: "Instrument to test" },
  describe: (args) => `BT ${args.symbols[0] ?? ""}`,
  discovery: {
    aliases: ["BT", "BTST"],
    screenshotReadiness: "live-dom",
    limitations: [
      "Long-only, one instrument, daily bars; signals fill at the next session's open.",
      "Price return (distributions not included): the closes are not adjusted for dividends or fund distributions, and borrow and cash interest are not modelled.",
    ],
  },
  options: [
    // No default: a run given --entry or --exit and no preset tests those rules, and one given both is refused.
    { key: "preset", type: "enum",
      description: `Strategy preset, ${DEFAULT_PRESET.id} when neither it nor a rule is given; --entry and --exit alone (or with custom) test your own rules`,
      values: [...BACKTEST_PRESETS.map(({ id }) => ({ value: id })), { value: CUSTOM_PRESET_ID }] },
    { key: "entry", type: "string", defaultValue: "", description: `Custom entry rule, for example 'close > sma(200)' or 'weekday == 3'. ${RULE_SYNTAX}` },
    { key: "exit", type: "string", defaultValue: "", description: "Custom exit rule, for example 'close < sma(200)' or 'weekday == 4'. Same operands and comparisons as --entry" },
    { key: "lookback", type: "enum", defaultValue: "10", values: [{ value: "5" }, { value: "10" }, { value: "max" }], description: "Evaluation years after indicator warmup" },
    { key: "cost", type: "integer", defaultValue: 5, minimum: 0, maximum: 100, description: "Cost per side in basis points" },
    { key: "end", type: "string", defaultValue: "", placeholder: "date", example: "--end 2026-10-16 --json",
      description: `Last session to test, as ${DATE_OPTION_EXAMPLES}, so the same run gives the same curve, trades and statistics; the newest complete session when omitted`,
      normalize: (value) => isoDateOption(value, "end") },
    { key: "include-partial", settingKey: "includePartial", type: "boolean", defaultValue: false,
      description: "Keep a session still forming (partial), which is left out by default because its close moves until the day ends" },
    { key: "equity", shot: { reportOnly: "prints the daily equity curve in place of the summary" }, type: "boolean", defaultValue: false, example: "--csv --equity > curve.csv",
      description: "Report the daily curve instead: date, close in the listing's currency, position (1 long, 0 flat), strategy and"
        + " buy-and-hold growth of 1 on the price alone (distributions not included) and drawdown in percent, every digit in --csv and --json" },
    { key: "tab", type: "enum", defaultValue: "summary", values: [{ value: "summary" }, { value: "trades" }], description: "Initial view",
      pluginState: { pluginId: "ticker-research", key: "backtest:view" } },
  ],
  async load(args, ctx) {
    const preset = args.options.preset == null ? null : String(args.options.preset);
    const typedEntry = String(args.options.entry ?? ""), typedExit = String(args.options.exit ?? "");
    const conflict = presetRulesConflict(preset, typedEntry, typedExit);
    if (conflict) throw new Error(conflict);
    const rules = resolveRules(preset, typedEntry, typedExit);
    const entry = parseRule(rules.entry), exit = parseRule(rules.exit);
    const instrument = await resolveHeadlessInstrument(ctx, args.symbols[0]!);
    const [history, unit] = await Promise.all([
      loadBacktestHistory(instrument, { signal: ctx.signal }, createBacktestDependencies(ctx.marketData)),
      priceUnit(ctx, instrument),
    ]);
    const costBps = Number(args.options.cost ?? 5);
    const window = { end: String(args.options.end ?? "").trim() || null, includePartial: args.options["include-partial"] === true };
    const result = runHistoryBacktest(history, entry, exit, {
      lookbackYears: lookbackYears(args.options.lookback), costBps, ...window,
    });
    return backtestReport({
      symbol: history.symbol, exchange: instrument.exchange ?? null, rules, costBps, window, unit, result,
      equity: args.options.equity === true,
    });
  },
};
