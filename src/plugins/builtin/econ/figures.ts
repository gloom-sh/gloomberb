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

// `-4.1M bbl`, `3%`, `30.3K`, `77 Bcf`, `50.9`: a sign, digits, a scale letter, then `%` or a unit word.
const FIGURE = /^([+-]?)(\d+)(?:\.(\d+))?([KMBT])?(?:(%)|\s+([A-Za-z][A-Za-z/]*))?$/;

/**
 * The number, unit and scale of a figure the calendar prints; null for a text
 * that is not one figure (`<1.25%` is a bound, not a value) and for a missing one.
 */
export function parseEconFigure(text: string | null | undefined): EconFigure | null {
  const match = FIGURE.exec((text ?? "").trim().replace(/\u2212/g, "-"));
  if (!match) return null;
  const [, sign, whole, fraction = "", letter, percent, word] = match;
  const digits = letter ? SCALE_DIGITS[letter]! : 0;
  // Parsed from the decimal text, so 0.987M is exactly 987000 and not 986999.9999999999.
  const value = Number(`${sign === "-" ? "-" : ""}${whole}.${fraction || "0"}e${digits}`);
  return { value: Object.is(value, -0) ? 0 : value, unit: percent ? "%" : word ?? "", scale: 10 ** digits };
}

/** What a row's Actual, Forecast and Prior say in numbers, with the one unit and scale they are drawn in. */
export interface EconRowFigures {
  actual: number | null;
  forecast: number | null;
  prior: number | null;
  /** The unit of the row's figures; null when it has no figure or they are plain counts. */
  unit: string | null;
  /** The scale the first of its figures is drawn in (actual, else forecast, else prior); null when it has none. */
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
