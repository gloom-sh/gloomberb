import type { ChartMarketSession, ChartSessionBackgroundKind, ChartSessionBackgroundSpan } from "./core/types";

const INTRADAY_SESSION_GAP_MS = 6 * 60 * 60_000;
const MAX_SESSION_BACKGROUND_WINDOW_MS = 10 * 24 * 60 * 60_000;

const US_EXTENDED_HOURS_SESSION: ChartMarketSession = {
  timeZone: "America/New_York",
  preMarketStartMinutes: 4 * 60,
  regularStartMinutes: 9 * 60 + 30,
  regularEndMinutes: 16 * 60,
  postMarketEndMinutes: 20 * 60,
};

const US_EXCHANGE_PATTERN = /\b(NASDAQ|NYSE|AMEX|ARCA|BATS|IEX|NMS|XNAS|XNYS|ARCX|XASE|NYSEARCA|NASDAQGS|NASDAQGM|NASDAQCM)\b/i;
const EQUITY_LIKE_ASSET_CATEGORIES = new Set(["", "STK", "ETF", "ADR", "EQUITY"]);

interface MarketSessionSource {
  exchange?: string | null;
  primaryExchange?: string | null;
  currency?: string | null;
  assetCategory?: string | null;
}

interface ZonedDateTime {
  dayKey: string;
  minutes: number;
}

const zonedFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getZonedFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = zonedFormatterCache.get(timeZone);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  zonedFormatterCache.set(timeZone, formatter);
  return formatter;
}

function normalizeDate(value: Date | string | number): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getMinPositiveGapMs(dates: readonly Date[]): number {
  let minGapMs = Number.POSITIVE_INFINITY;
  for (let index = 1; index < dates.length; index += 1) {
    const gapMs = Math.abs(dates[index]!.getTime() - dates[index - 1]!.getTime());
    if (gapMs > 0 && gapMs < minGapMs) {
      minGapMs = gapMs;
    }
  }
  return Number.isFinite(minGapMs) ? minGapMs : 0;
}

function isIntradaySeries(dates: readonly Date[]): boolean {
  if (dates.length < 2) return false;
  const minGapMs = getMinPositiveGapMs(dates);
  return minGapMs > 0 && minGapMs <= INTRADAY_SESSION_GAP_MS;
}

function getDateSpanMs(dates: readonly Date[]): number {
  let minTime = Number.POSITIVE_INFINITY;
  let maxTime = Number.NEGATIVE_INFINITY;
  for (const date of dates) {
    const time = date.getTime();
    if (time < minTime) minTime = time;
    if (time > maxTime) maxTime = time;
  }
  return Number.isFinite(minTime) && Number.isFinite(maxTime) ? maxTime - minTime : 0;
}

function shouldShowSessionBackgrounds(dates: readonly Date[]): boolean {
  return isIntradaySeries(dates) && getDateSpanMs(dates) <= MAX_SESSION_BACKGROUND_WINDOW_MS;
}

function getZonedDateTime(date: Date, timeZone: string): ZonedDateTime | null {
  const values = new Map<string, string>();
  for (const part of getZonedFormatter(timeZone).formatToParts(date)) {
    if (part.type !== "literal") values.set(part.type, part.value);
  }

  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  const hour = values.get("hour");
  const minute = values.get("minute");
  if (!year || !month || !day || !hour || !minute) return null;

  return {
    dayKey: `${year}-${month}-${day}`,
    minutes: Number.parseInt(hour, 10) * 60 + Number.parseInt(minute, 10),
  };
}

function getSessionBackgroundKind(minutes: number, session: ChartMarketSession): ChartSessionBackgroundKind | null {
  if (minutes >= session.preMarketStartMinutes && minutes < session.regularStartMinutes) return "pre";
  if (minutes >= session.regularEndMinutes && minutes < session.postMarketEndMinutes) return "post";
  return null;
}

function isEquityLike(assetCategory: string | null | undefined): boolean {
  return EQUITY_LIKE_ASSET_CATEGORIES.has((assetCategory ?? "").trim().toUpperCase());
}

function hasUsExchange(source: MarketSessionSource): boolean {
  const exchangeText = [
    source.exchange,
    source.primaryExchange,
  ].filter(Boolean).join(" ");
  return US_EXCHANGE_PATTERN.test(exchangeText);
}

function isExplicitNonUsSource(source: MarketSessionSource): boolean {
  const exchangeText = [
    source.exchange,
    source.primaryExchange,
  ].filter(Boolean).join(" ");
  return exchangeText.length > 0 && !US_EXCHANGE_PATTERN.test(exchangeText) && (source.currency ?? "").toUpperCase() !== "USD";
}

export function resolveChartMarketSession(sources: readonly MarketSessionSource[]): ChartMarketSession | null {
  if (sources.length === 0) return null;
  if (sources.some((source) => !isEquityLike(source.assetCategory))) return null;
  if (sources.some(isExplicitNonUsSource)) return null;

  const hasSupportedSource = sources.some((source) => hasUsExchange(source) || (source.currency ?? "").toUpperCase() === "USD");
  return hasSupportedSource ? US_EXTENDED_HOURS_SESSION : null;
}

export function resolveExtendedHoursBackgroundSpans(
  values: readonly (Date | string | number)[],
  session: ChartMarketSession | null | undefined,
): ChartSessionBackgroundSpan[] {
  if (!session) return [];

  const dates = values.map(normalizeDate);
  const validDates = dates.filter((date): date is Date => date !== null);
  if (!shouldShowSessionBackgrounds(validDates)) return [];

  const spans: ChartSessionBackgroundSpan[] = [];
  let active: ChartSessionBackgroundSpan | null = null;
  let activeDayKey: string | null = null;

  for (let index = 0; index < dates.length; index += 1) {
    const date = dates[index];
    const zoned = date ? getZonedDateTime(date, session.timeZone) : null;
    const kind = zoned ? getSessionBackgroundKind(zoned.minutes, session) : null;
    if (!kind) {
      if (active) spans.push(active);
      active = null;
      activeDayKey = null;
      continue;
    }

    if (active && active.kind === kind && activeDayKey === zoned!.dayKey) {
      active.endIndex = index;
      continue;
    }

    if (active) spans.push(active);
    active = { kind, startIndex: index, endIndex: index };
    activeDayKey = zoned!.dayKey;
  }

  if (active) spans.push(active);
  return spans;
}
