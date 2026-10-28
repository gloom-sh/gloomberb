/**
 * The figures of an economic calendar row as numbers. The calendar serves
 * Actual, Forecast and Prior as the text a table prints (`3%`, `30.3K`,
 * `-4.1M bbl`, `77 Bcf`); an export reads them back so a script gets a number
 * and what it is a number of.
 */

/** A figure read back from its text. */
export interface EconFigure {
  /** The figure in its unit, its scale multiplied out: `30.3K` is 30300 and `3%` is 3. */
  value: number;
  /** What the figure counts: `%`, `bbl`, `b/d`, `Bcf`; empty for a plain count or index level. */
  unit: string;
  /** The multiplier the text drew it in: 1, or 1000 for `K`, 1e6 for `M`, 1e9 for `B`, 1e12 for `T`. */
  scale: number;
}

const SCALE_DIGITS: Readonly<Record<string, number>> = { K: 3, M: 6, B: 9, T: 12 };

// A sign, then the digits (grouped by commas, or with a decimal point or comma), a scale letter straight after them,
// then `%` or a unit word: `-4.1M bbl`, `3%`, `30k`, `1,250`, `1,5%`, `77 Bcf`, `50.9`. A range, a bound (`<1.25%`)
// or a figure with more words after it (`3% y/y`) is not one.
const FIGURE = /^([+-]?)(?:(\d{1,3}(?:,\d{3})+(?:\.\d+)?)|(\d+(?:[.,]\d+)?|\.\d+))(?:([KMBT])(?![A-Za-z]))?(?:(%)|\s*([A-Za-z][A-Za-z/.]*(?:\s+[A-Za-z/.]+)*))?$/i;

/**
 * The number, unit and scale of a figure the calendar prints; null for a text
 * that is not one figure (`<1.25%` is a bound, not a value) and for a missing one.
 * The one reading of a figure: the table's colours and every export use it, so
 * a figure the app can read is never a null in an export.
 */
export function parseEconFigure(text: string | null | undefined): EconFigure | null {
  const match = FIGURE.exec((text ?? "").trim().replace(/\u2212/g, "-"));
  if (!match) return null;
  const [, sign, grouped, plain, letter, percent, word] = match;
  const digits = letter ? SCALE_DIGITS[letter.toUpperCase()]! : 0;
  // A comma before exactly three digits groups thousands (1,250); before fewer it is a decimal comma (1,5).
  const number = grouped ? grouped.replace(/,/g, "") : plain!.replace(",", ".");
  // Parsed from the decimal text, so 0.987M is exactly 987000 and not 986999.9999999999.
  const value = Number(`${sign === "-" ? "-" : ""}${number}e${digits}`);
  return { value: Object.is(value, -0) ? 0 : value, unit: percent ? "%" : word ?? "", scale: 10 ** digits };
}

/** What a row's Actual, Forecast and Prior say in numbers, with the unit they share and the scale the first is drawn in. */
export interface EconRowFigures {
  actual: number | null;
  forecast: number | null;
  prior: number | null;
  /** The unit of the row's figures; null when it has no figure or they are plain counts. */
  unit: string | null;
  /**
   * The scale the first of its figures is drawn in (actual, else forecast, else prior); null when it has none.
   * Each figure is multiplied out by its own, so `950K` beside `1.2M` is 950000 and 1200000 under scale 1000.
   */
  scale: number | null;
}

/**
 * A row's three figures as numbers. They share one unit; a figure drawn in
 * another (none is today) is null rather than a number in the wrong unit.
 */
export function econRowFigures(row: { actual?: string | null; forecast?: string | null; prior?: string | null }): EconRowFigures {
  const figures = [row.actual, row.forecast, row.prior].map(parseEconFigure);
  const first = figures.find((figure): figure is EconFigure => figure != null);
  const numbers = figures.map((figure) => figure && first && figure.unit === first.unit ? figure.value : null);
  return {
    actual: numbers[0]!,
    forecast: numbers[1]!,
    prior: numbers[2]!,
    unit: first?.unit ? first.unit : null,
    scale: first?.scale ?? null,
  };
}

/** A figure printed as a bare number, with no unit and no scale letter: `0.6`, `-3`, `1,5`. */
const BARE_NUMBER = /^[+-]?(?:\d+(?:[.,]\d+)?|\.\d+)$/;

/**
 * Release names that are a percent whatever one row's figures say: a change
 * month on month, quarter on quarter or year on year, and the rates published
 * in percent. "Consumer Inflation Expectations" is a balance, not a rate, and
 * is not one of them.
 */
const PERCENT_NAME = /\b(?:mom|qoq|yoy)\b|(?:^|\s)[mqy]\/[mqy](?=\s|$)|\b(?:inflation|unemployment|jobless|interest|growth|mortgage|funds|participation|savings) rate\b/i;

type EconRowText = { country: string; event: string; indicatorId?: string | null; actual: string | null; forecast: string | null; prior: string | null };

const FIGURE_KEYS = ["actual", "forecast", "prior"] as const;

/** Every release of one indicator: its id, else its country and name. */
const indicatorKey = (event: Pick<EconRowText, "country" | "event" | "indicatorId">) => event.indicatorId || `${event.country}|${event.event}`;

/**
 * The calendar with every figure of a percent indicator in percent. The feeds
 * drop the sign on some rows: US Inflation Rate MoM's prior came as `0.6`, and
 * the 30-year mortgage rate's as `7.32` beside its actual `7.41%`. An
 * indicator is in percent when any of its figures is, or its name says so
 * (`PERCENT_NAME`), and none of its figures is in another unit or scale; its
 * bare figures then carry `%`. Anything else is left as the feed wrote it.
 */
export function withPercentUnits<T extends EconRowText>(events: readonly T[]): T[] {
  const indicators = new Map<string, { percent: boolean; other: boolean }>();
  for (const event of events) {
    const key = indicatorKey(event);
    const seen = indicators.get(key) ?? { percent: false, other: false };
    if (PERCENT_NAME.test(event.event)) seen.percent = true;
    for (const field of FIGURE_KEYS) {
      const figure = parseEconFigure(event[field]);
      if (!figure) continue;
      if (figure.unit === "%") seen.percent = true;
      else if (figure.unit || figure.scale !== 1) seen.other = true;
    }
    indicators.set(key, seen);
  }
  return events.map((event) => {
    const seen = indicators.get(indicatorKey(event))!;
    if (!seen.percent || seen.other) return event;
    const bare = FIGURE_KEYS.filter((field) => BARE_NUMBER.test(event[field]?.trim() ?? ""));
    return bare.length ? { ...event, ...Object.fromEntries(bare.map((field) => [field, `${event[field]!.trim()}%`])) } : event;
  });
}
