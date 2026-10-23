/**
 * The largest fall from a close to a later close (docs/usage.md, under `history`):
 * the peak it fell from and the trough it reached, each with its date, the
 * fall as a fraction of the peak, and the first later close back at the peak,
 * if any. Read off closes, as returns are; a missing or non-positive close is
 * passed over. The earliest of equal falls is the one named.
 */
export interface MaxDrawdown {
  peak: { date: string; close: number };
  trough: { date: string; close: number };
  /** trough / peak - 1: 0 when no close fell below an earlier one, else negative. */
  drawdown: number;
  /** The first date after the trough whose close is back at the peak; null when none is in the series. */
  recovered: string | null;
  /** The last date in the series, which a fall not yet recovered is measured to. */
  through: string;
}

interface ClosePoint {
  /** An ISO date or instant; points sort by it. */
  date: string;
  close: number | null | undefined;
}

/** The series' max drawdown, or null with fewer than two closes. */
export function maxDrawdown(points: readonly ClosePoint[]): MaxDrawdown | null {
  const closes = points
    .filter((point): point is { date: string; close: number } => typeof point.close === "number" && Number.isFinite(point.close) && point.close > 0)
    .toSorted((left, right) => left.date.localeCompare(right.date));
  if (closes.length < 2) return null;
  let peak = closes[0]!;
  let worst = { peak, trough: peak, drawdown: 0 };
  for (const point of closes) {
    if (point.close > peak.close) peak = point;
    const fall = point.close / peak.close - 1;
    if (fall < worst.drawdown) worst = { peak, trough: point, drawdown: fall };
  }
  const recovered = worst.drawdown < 0
    ? closes.find((point) => point.date > worst.trough.date && point.close >= worst.peak.close)?.date ?? null
    : null;
  return {
    peak: { date: worst.peak.date, close: worst.peak.close },
    trough: { date: worst.trough.date, close: worst.trough.close },
    drawdown: worst.drawdown,
    recovered,
    through: closes.at(-1)!.date,
  };
}

/**
 * The report line: `Max drawdown -69.6% (daily closes): peak 53.25 on 2007-05-30, trough 16.19 on 2009-03-09,
 * not back to the peak by 2009-12-31`. `price` and `date` draw a close and a date as the table does.
 */
export function maxDrawdownText(
  value: MaxDrawdown,
  { basis, price, date = (text) => text.slice(0, 10) }: { basis: string; price: (value: number) => string; date?: (text: string) => string },
): string {
  const percent = (value.drawdown * 100).toFixed(1);
  // A fall that rounds to nothing is still a fall, which -0.0% would hide.
  const head = `Max drawdown ${percent === "-0.0" ? "under 0.1%" : `${percent}%`} (${basis})`;
  if (value.drawdown === 0) return `${head}: no close fell below an earlier one`;
  const back = value.recovered ? `back to the peak on ${date(value.recovered)}` : `not back to the peak by ${date(value.through)}`;
  return `${head}: peak ${price(value.peak.close)} on ${date(value.peak.date)}, trough ${price(value.trough.close)} on ${date(value.trough.date)}, ${back}`;
}
