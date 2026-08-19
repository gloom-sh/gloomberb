import type { TimeRange } from "../../../components/chart/core/types";
import type { PaneSettingsDef } from "../../../types/plugin";
import { formatTickerListInput, MAX_TICKER_LIST_SIZE, parseTickerListInput } from "../../../tickers/list";

export const MAX_CORRELATION_TICKERS = MAX_TICKER_LIST_SIZE;
const DEFAULT_CORRELATION_RANGE: CorrelationRangePreset = "1Y";
export const CORRELATION_RANGE_OPTIONS = ["1M", "3M", "6M", "1Y", "5Y"] as const;
export const DEFAULT_CORRELATION_SYMBOLS = ["AAPL", "MSFT", "NVDA", "AMD"];

export type CorrelationRangePreset = Extract<TimeRange, typeof CORRELATION_RANGE_OPTIONS[number]>;

export interface CorrelationPaneSettings {
  rangePreset: CorrelationRangePreset;
  symbols: string[];
  symbolsText: string;
  symbolsError: string | null;
}

function isCorrelationRangePreset(value: unknown): value is CorrelationRangePreset {
  return CORRELATION_RANGE_OPTIONS.includes(value as CorrelationRangePreset);
}

function normalizeCorrelationRange(value: unknown): CorrelationRangePreset {
  return isCorrelationRangePreset(value) ? value : DEFAULT_CORRELATION_RANGE;
}

function parseCorrelationSymbolsInput(raw: string, maxTickers = MAX_CORRELATION_TICKERS): string[] {
  return parseTickerListInput(raw, maxTickers);
}

function coerceStoredSymbols(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const text = value.filter((entry): entry is string => typeof entry === "string").join(",");
  try {
    return parseCorrelationSymbolsInput(text, MAX_CORRELATION_TICKERS);
  } catch {
    return [];
  }
}

export function getCorrelationPaneSettings(settings: Record<string, unknown> | undefined): CorrelationPaneSettings {
  const rangePreset = normalizeCorrelationRange(settings?.rangePreset);
  const storedText = typeof settings?.symbolsText === "string" ? settings.symbolsText : null;
  const storedSymbols = coerceStoredSymbols(settings?.symbols);
  let symbols = storedSymbols.length > 0 ? storedSymbols : DEFAULT_CORRELATION_SYMBOLS;
  let symbolsText = storedText ?? formatTickerListInput(symbols);
  let symbolsError: string | null = null;

  if (storedText !== null) {
    if (storedText.trim().length === 0) {
      symbols = DEFAULT_CORRELATION_SYMBOLS;
      symbolsText = formatTickerListInput(symbols);
    } else {
      try {
        symbols = parseCorrelationSymbolsInput(storedText, MAX_CORRELATION_TICKERS);
        symbolsText = storedText;
      } catch (error) {
        symbols = [];
        symbolsError = error instanceof Error ? error.message : "Invalid ticker list.";
      }
    }
  }

  return {
    rangePreset,
    symbols,
    symbolsText,
    symbolsError,
  };
}

export function buildCorrelationSettingsDef(): PaneSettingsDef {
  return {
    title: "Correlation Matrix Settings",
    fields: [
      {
        key: "symbolsText",
        label: "Tickers",
        description: `Enter up to ${MAX_CORRELATION_TICKERS} tickers. Empty uses the default CORR preset.`,
        type: "text",
        placeholder: formatTickerListInput(DEFAULT_CORRELATION_SYMBOLS),
      },
      {
        key: "rangePreset",
        label: "Range",
        type: "select",
        options: CORRELATION_RANGE_OPTIONS.map((range) => ({
          value: range,
          label: range,
        })),
      },
    ],
  };
}
