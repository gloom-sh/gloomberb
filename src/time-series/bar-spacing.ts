const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The typical spacing of a series of bar times: the median gap between
 * consecutive distinct times, so the long gap a holiday leaves (Golden Week
 * closes Shanghai from 30 Sep to 8 Oct) does not read as the bar size. Null
 * with fewer than two distinct times.
 */
export function medianBarGap(times: readonly number[]): number | null {
  const finite = times.filter(Number.isFinite).sort((left, right) => left - right);
  const gaps = finite.slice(1).map((time, index) => time - finite[index]!).filter((gap) => gap > 0).sort((left, right) => left - right);
  return gaps.length > 0 ? gaps[Math.floor((gaps.length - 1) / 2)]! : null;
}

/** A bar size of a day or more read from the typical spacing of its bars (medianBarGap). */
export function barSizeFromGap(gapMs: number): "1d" | "1wk" | "1mo" {
  const days = gapMs / DAY_MS;
  return days >= 25 ? "1mo" : days >= 6 ? "1wk" : "1d";
}
