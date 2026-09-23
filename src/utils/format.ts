import { toTimestampMillis } from "./timestamp";

const currencyFormatters = new Map<string, Intl.NumberFormat>();
const numberFormatters = new Map<number, Intl.NumberFormat>();

function getCurrencyFormatter(currency: string, maximumFractionDigits = 2): Intl.NumberFormat {
  const key = `${currency}:${maximumFractionDigits}`;
  let formatter = currencyFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits,
    });
    currencyFormatters.set(key, formatter);
  }
  return formatter;
}

function getNumberFormatter(decimals: number): Intl.NumberFormat {
  let formatter = numberFormatters.get(decimals);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    numberFormatters.set(decimals, formatter);
  }
  return formatter;
}

/** Format a number as currency (e.g., $1,234.56) */
export function formatCurrency(value: number | undefined, currency = "USD", maximumFractionDigits = 2): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return getCurrencyFormatter(currency, maximumFractionDigits).format(value);
}

/** Preserve fractional per-share distributions, including split-adjusted history. */
export function formatDistributionAmount(value: number | undefined, currency = "USD"): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return getCurrencyFormatter(currency, 6).format(value);
}

/** Format a number as percentage (e.g., +1.23%) */
export function formatPercent(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(2)}%`;
}

/** Format a level such as a yield or margin (0.0123 -> 1.23%). Levels are not changes, so they carry no sign. */
export function formatLevelPercent(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const fixed = (value * 100).toFixed(2);
  return `${/[1-9]/.test(fixed) ? fixed : fixed.replace("-", "")}%`;
}

/** Format a percentage that's already in percent form (e.g., 1.23 -> +1.23%) */
export function formatPercentRaw(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

/**
 * Format large numbers compactly (e.g., 1.5T, 234B, 12.3M, 5k). Table columns
 * pass `fixedDecimals` so 1.70T lines up with 1.33T.
 */
export function formatCompact(value: number | undefined, { fixedDecimals = false }: { fixedDecimals?: boolean } = {}): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const fmt = (n: number, decimals: number, suffix: string) => {
    const fixed = n.toFixed(decimals);
    // Strip unnecessary trailing zeros after decimal point
    const trimmed = fixed.includes(".") && (!fixedDecimals || !suffix) ? fixed.replace(/\.?0+$/, "") : fixed;
    // A value that rounds to zero carries no sign.
    const sign = value < 0 && /[1-9]/.test(trimmed) ? "-" : "";
    return `${sign}${trimmed}${suffix}`;
  };
  if (abs >= 1e12) return fmt(abs / 1e12, 2, "T");
  if (abs >= 1e9) return fmt(abs / 1e9, 2, "B");
  if (abs >= 1e6) return fmt(abs / 1e6, 2, "M");
  if (abs >= 1e3) return fmt(abs / 1e3, 1, "k");
  return fmt(abs, 2, "");
}

/** Format a compact value with an explicit currency code (e.g., 1.5T USD) */
export function formatCompactCurrency(value: number | undefined, currency = "USD"): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${formatCompact(value)} ${currency}`;
}

/** Format a plain number with commas */
export function formatNumber(value: number | undefined, decimals = 2): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return getNumberFormatter(decimals).format(value);
}

/** Format a growth rate compactly (e.g., +12%, -5%) */
export function formatGrowthShort(value: number): string {
  const pct = value * 100;
  const sign = pct > 0 ? "+" : "";
  if (Math.abs(pct) >= 10) return `${sign}${Math.round(pct)}%`;
  // A change that rounds to zero prints 0.0%, never -0.0%.
  return Math.abs(pct) < 0.05 ? "0.0%" : `${sign}${pct.toFixed(1)}%`;
}

/** Pick a common unit suffix for a set of numbers */
export function pickUnit(values: (number | undefined)[]): { suffix: string; divisor: number } {
  const defined = values.filter((v): v is number => v != null);
  if (!defined.length) return { suffix: "", divisor: 1 };
  const maxAbs = Math.max(...defined.map(Math.abs));
  if (maxAbs >= 1e12) return { suffix: "T", divisor: 1e12 };
  if (maxAbs >= 1e9) return { suffix: "B", divisor: 1e9 };
  if (maxAbs >= 1e6) return { suffix: "M", divisor: 1e6 };
  if (maxAbs >= 1e3) return { suffix: "K", divisor: 1e3 };
  return { suffix: "", divisor: 1 };
}

/** Format a number using a pre-determined divisor (no unit suffix) */
export function formatWithDivisor(value: number | undefined, divisor: number): string {
  if (value === undefined || value === null) return "—";
  const scaled = value / divisor;
  const abs = Math.abs(scaled);
  const decimals = abs >= 100 ? 1 : 2;
  return scaled.toFixed(decimals);
}

const COMBINING_MARK_RE = /\p{Mark}/u;
const EMOJI_PRESENTATION_RE = /\p{Emoji_Presentation}/u;
const EXTENDED_PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/u;
const REGIONAL_INDICATOR_RE = /\p{Regional_Indicator}/u;

/**
 * Printable ASCII is always one cell per code unit. Table cells are mostly
 * numbers, tickers, and dates, so this skips grapheme segmentation on the
 * render hot path.
 */
const SINGLE_WIDTH_ASCII_RE = /^[\x20-\x7e]*$/;

let graphemeSegmenter: { segment(value: string): Iterable<{ segment: string }> } | null | undefined;

// Constructing Intl.Segmenter costs about 10us; segmenting with a shared one
// costs a fraction of that, and the instance carries no per-call state.
function getGraphemeSegmenter(): typeof graphemeSegmenter {
  if (graphemeSegmenter === undefined) {
    const Segmenter = (Intl as any).Segmenter;
    graphemeSegmenter = typeof Segmenter === "function"
      ? new Segmenter(undefined, { granularity: "grapheme" })
      : null;
  }
  return graphemeSegmenter;
}

function segmentGraphemes(value: string): string[] {
  const segmenter = getGraphemeSegmenter();
  if (segmenter) {
    return Array.from(segmenter.segment(value), (entry) => entry.segment);
  }
  return Array.from(value);
}

function isFullwidthCodePoint(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function graphemeWidth(segment: string): number {
  if (
    REGIONAL_INDICATOR_RE.test(segment) ||
    EMOJI_PRESENTATION_RE.test(segment) ||
    EXTENDED_PICTOGRAPHIC_RE.test(segment)
  ) {
    return 2;
  }

  let width = 0;
  for (const char of Array.from(segment)) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (
      codePoint === 0 ||
      codePoint < 32 ||
      (codePoint >= 0x7f && codePoint < 0xa0) ||
      codePoint === 0x200d ||
      (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
      COMBINING_MARK_RE.test(char)
    ) {
      continue;
    }
    width += isFullwidthCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

export function displayWidth(value: string): number {
  if (SINGLE_WIDTH_ASCII_RE.test(value)) return value.length;
  return segmentGraphemes(value).reduce((total, segment) => total + graphemeWidth(segment), 0);
}

function truncateToWidth(value: string, width: number): string {
  if (width <= 0) return "";
  if (SINGLE_WIDTH_ASCII_RE.test(value)) return value.slice(0, width);
  let output = "";
  let used = 0;
  for (const segment of segmentGraphemes(value)) {
    const nextWidth = graphemeWidth(segment);
    if (used + nextWidth > width) break;
    output += segment;
    used += nextWidth;
  }
  return output;
}

export function truncateToDisplayWidth(value: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(value) <= width) return value;
  if (width <= 3) return ".".repeat(width);
  return `${truncateToWidth(value, width - 3)}...`;
}

/**
 * Clips to a display width behind a single `…`, which gives a narrow cell back
 * two characters that `...` would spend on the marker.
 */
export function clipToDisplayWidth(value: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(value) <= width) return value;
  if (width === 1) return "…";
  return `${truncateToWidth(value, width - 1).trimEnd()}…`;
}

/**
 * Clips a styled run of text to a display width. A highlighted snippet is many
 * text nodes rather than one string, so the clipping cannot go through
 * `truncateToDisplayWidth`; the ellipsis is built by the caller so the returned
 * segments keep whatever styling flags the caller's segment type carries.
 */
export function truncateTextSegments<T extends { text: string }>(
  segments: T[],
  width: number,
  makeEllipsis: (ellipsis: string) => T,
): T[] {
  if (width <= 0) return [];
  const total = segments.reduce((sum, segment) => sum + displayWidth(segment.text), 0);
  if (total <= width) return segments;
  if (width <= 1) return [makeEllipsis("\u2026".slice(0, width))];

  const budget = width - 1;
  const clipped: T[] = [];
  let used = 0;
  for (const segment of segments) {
    const remaining = budget - used;
    if (remaining <= 0) break;
    const segmentWidth = displayWidth(segment.text);
    if (segmentWidth <= remaining) {
      clipped.push(segment);
      used += segmentWidth;
      continue;
    }
    clipped.push({ ...segment, text: truncateToWidth(segment.text, remaining) });
    break;
  }
  clipped.push(makeEllipsis("\u2026"));
  return clipped;
}

/** Pad/truncate a string to a fixed display width */
export function padTo(str: string, width: number, align: "left" | "right" | "center" = "left"): string {
  const clipped = displayWidth(str) > width ? truncateToWidth(str, width) : str;
  const clippedWidth = displayWidth(clipped);
  const padding = Math.max(0, width - clippedWidth);
  if (align === "right") return " ".repeat(padding) + clipped;
  if (align === "center") {
    const leftPadding = Math.floor(padding / 2);
    const rightPadding = padding - leftPadding;
    return " ".repeat(leftPadding) + clipped + " ".repeat(rightPadding);
  }
  return clipped + " ".repeat(padding);
}

/**
 * Convert using USD-per-unit rates. Missing FX remains unavailable (NaN), so
 * totals cannot silently mix source currency with base currency. Numeric
 * formatters render this as a dash and JSON encodes it as null.
 */
export function convertCurrency(
  value: number,
  fromCurrency: string,
  baseCurrency: string,
  exchangeRates: Map<string, number>,
): number {
  if (!Number.isFinite(value)) return Number.NaN;
  if (fromCurrency === baseCurrency || value === 0) return value;
  const fromRate = fromCurrency === "USD" ? 1 : exchangeRates.get(fromCurrency);
  const baseRate = baseCurrency === "USD" ? 1 : exchangeRates.get(baseCurrency);
  if (fromRate == null || baseRate == null || !Number.isFinite(fromRate) || !Number.isFinite(baseRate)
    || fromRate <= 0 || baseRate <= 0) return Number.NaN;
  return (value * fromRate) / baseRate;
}

/** Format a date/timestamp as relative time (e.g., "5m ago", "2h ago") */
export function formatTimeAgo(date: Date | string): string {
  const ts = toTimestampMillis(date);
  if (Number.isNaN(ts)) return "unknown";
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "2-digit" });
}
