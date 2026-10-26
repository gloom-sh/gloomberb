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
