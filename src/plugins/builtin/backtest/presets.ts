export interface BacktestPreset {
  id: string;
  label: string;
  entry: string;
  exit: string;
}

/**
 * Standard single-instrument rules. Presets use states (>, <), so a test that
 * starts inside a regime is already invested; "crosses" is available for
 * custom rules that should wait for a fresh signal. "custom" keeps the rules
 * typed in settings.
 */
export const BACKTEST_PRESETS: BacktestPreset[] = [
  { id: "golden-cross", label: "Golden cross (50/200)", entry: "sma(50) > sma(200)", exit: "sma(50) < sma(200)" },
  { id: "trend-200", label: "Above 200-day average", entry: "close > sma(200)", exit: "close < sma(200)" },
  { id: "rsi-reversion", label: "RSI 30/50 reversion", entry: "rsi(14) < 30", exit: "rsi(14) > 50" },
  { id: "macd-cross", label: "MACD signal cross", entry: "macd(12,26,9) > macd_signal(12,26,9)", exit: "macd(12,26,9) < macd_signal(12,26,9)" },
  { id: "bollinger-reversion", label: "Bollinger reversion", entry: "close < bb_lower(20,2)", exit: "close > sma(20)" },
  { id: "breakout-55-20", label: "55/20-day breakout", entry: "close > highest(55)", exit: "close < lowest(20)" },
];
export const DEFAULT_PRESET = BACKTEST_PRESETS[0]!;
export const LOOKBACK_OPTIONS = [
  { value: "5", label: "5 years" },
  { value: "10", label: "10 years" },
  { value: "max", label: "All history" },
];

/** A preset's rules, or the typed ones for "custom". */
export function resolveRules(preset: string, entry: string, exit: string): { entry: string; exit: string; label: string } {
  const match = BACKTEST_PRESETS.find((candidate) => candidate.id === preset);
  return match ? { entry: match.entry, exit: match.exit, label: match.label } : { entry, exit, label: "Custom rules" };
}
export const lookbackYears = (value: unknown) => value === "max" ? null : value === "5" ? 5 : 10;
