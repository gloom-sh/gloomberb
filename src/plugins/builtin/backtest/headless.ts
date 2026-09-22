import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { resolveHeadlessInstrument } from "../shared/headless-market-data";
import { createBacktestDependencies, loadBacktestHistory } from "./client";
import { runBacktest } from "./engine";
import { formatStat, SUMMARY_ROWS } from "./format";
import { BACKTEST_PRESETS, DEFAULT_PRESET, lookbackYears, resolveRules } from "./presets";
import { parseRule } from "./rules";

export const backtestHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  argument: { kind: "ticker", description: "Instrument to test" },
  describe: (args) => `BT ${args.symbols[0] ?? ""}`,
  discovery: {
    aliases: ["BT", "BTST"],
    screenshotReadiness: "live-dom",
    limitations: [
      "Long-only, one instrument, daily bars; signals fill at the next session's open",
      "Price returns: dividends, borrow and cash interest are not modelled",
    ],
  },
  options: [
    { key: "preset", type: "enum", defaultValue: DEFAULT_PRESET.id, description: "Strategy preset, or custom to use --entry and --exit",
      values: [...BACKTEST_PRESETS.map(({ id }) => ({ value: id })), { value: "custom" }] },
    { key: "entry", type: "string", defaultValue: "", description: "Custom entry rule, for example 'close > sma(200)'" },
    { key: "exit", type: "string", defaultValue: "", description: "Custom exit rule, for example 'close < sma(200)'" },
    { key: "lookback", type: "enum", defaultValue: "10", values: [{ value: "5" }, { value: "10" }, { value: "max" }], description: "Evaluation years after indicator warmup" },
    { key: "cost", type: "integer", defaultValue: 5, minimum: 0, maximum: 100, description: "Cost per side in basis points" },
    { key: "tab", type: "enum", defaultValue: "summary", values: [{ value: "summary" }, { value: "trades" }], description: "Initial view",
      pluginState: { pluginId: "ticker-research", key: "backtest:view" } },
  ],
  async load(args, ctx) {
    const preset = String(args.options.preset ?? DEFAULT_PRESET.id);
    const rules = resolveRules(preset, String(args.options.entry ?? ""), String(args.options.exit ?? ""));
    const entry = parseRule(rules.entry), exit = parseRule(rules.exit);
    const instrument = await resolveHeadlessInstrument(ctx, args.symbols[0]!);
    const history = await loadBacktestHistory(instrument, { signal: ctx.signal }, createBacktestDependencies(ctx.marketData));
    const costBps = Number(args.options.cost ?? 5);
    const result = runBacktest(history.bars, entry, exit, { lookbackYears: lookbackYears(args.options.lookback), costBps });
    return {
      complete: true,
      errors: result.warnings,
      sections: [
        { title: `${rules.label} · ${result.start} to ${result.end}`, columns: [
          { key: "metric", header: "Metric" },
          { key: "strategy", header: "Strategy", align: "right" as const },
          { key: "benchmark", header: "Buy & hold", align: "right" as const },
        ], rows: SUMMARY_ROWS.map((row) => ({ metric: row.label, strategy: formatStat(row.strategy(result)), benchmark: formatStat(row.benchmark?.(result) ?? null) })) },
        { title: "Trades", columns: [
          { key: "entryDate", header: "Entry" }, { key: "entryPrice", header: "Entry price", align: "right" as const },
          { key: "exitDate", header: "Exit" }, { key: "exitPrice", header: "Exit price", align: "right" as const },
          { key: "returnPct", header: "Return %", align: "right" as const }, { key: "sessions", header: "Sessions", align: "right" as const },
        ], rows: result.trades.map((trade) => ({
          entryDate: trade.entryDate, entryPrice: trade.entryPrice.toFixed(2),
          exitDate: trade.open ? "open" : trade.exitDate, exitPrice: trade.exitPrice?.toFixed(2) ?? "--",
          returnPct: trade.returnPct.toFixed(2), sessions: trade.sessions,
        })) },
      ],
      metadata: { symbol: history.symbol, source: history.source, rules: { ...rules, costBps }, result },
    };
  },
};
