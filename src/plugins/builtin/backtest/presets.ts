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

export const CUSTOM_PRESET_ID = "custom";

const typedRule = (entry: string, exit: string) => entry.trim() !== "" || exit.trim() !== "";

/**
 * The strategy a run tests: the preset chosen; with none chosen, the typed
 * rules when there are any (`fn BT --entry ... --exit ...` means custom),
 * else the default preset.
 */
export function strategyPreset(preset: string | null | undefined, entry: string, exit: string): string {
  if (preset) return preset;
  return typedRule(entry, exit) ? CUSTOM_PRESET_ID : DEFAULT_PRESET.id;
}

/** A preset's rules, or the typed ones for "custom" and for rules typed with no preset chosen. */
export function resolveRules(preset: string | null | undefined, entry: string, exit: string): { entry: string; exit: string; label: string } {
  const id = strategyPreset(preset, entry, exit);
  const match = BACKTEST_PRESETS.find((candidate) => candidate.id === id);
  return match ? { entry: match.entry, exit: match.exit, label: match.label } : { entry, exit, label: "Custom rules" };
}

/**
 * Why rules typed beside a preset cannot both be tested (`--preset
 * golden-cross --entry ...`), naming both; null when they agree.
 */
export function presetRulesConflict(preset: string | null | undefined, entry: string, exit: string): string | null {
  if (!preset || preset === CUSTOM_PRESET_ID || !typedRule(entry, exit)) return null;
  const typed = [entry.trim() ? "--entry" : null, exit.trim() ? "--exit" : null].filter(Boolean).join(" and ");
  return `${typed} ${entry.trim() && exit.trim() ? "are custom rules" : "is a custom rule"}, but --preset ${preset} tests its own. `
    + `Leave out --preset to test the typed rules, or give --preset ${CUSTOM_PRESET_ID}.`;
}
export const lookbackYears = (value: unknown) => value === "max" ? null : value === "5" ? 5 : 10;
