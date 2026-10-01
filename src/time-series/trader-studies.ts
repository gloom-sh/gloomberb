/**
 * Studies that read whole bars (high, low, close and volume) rather than one
 * value per observation: session and anchored VWAP, average true range, and
 * the volume traded at each price over a set of bars.
 */

export interface StudyBar {
  time: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface VwapValue {
  index: number;
  value: number;
  /** Volume-weighted standard deviation of the typical price, for bands. */
  deviation: number;
}

function typicalPrice(bar: StudyBar): number {
  return (bar.high + bar.low + bar.close) / 3;
}

/**
 * The volume-weighted average typical price since the start of each session.
 * `sessionOf` names the session a bar belongs to and a new name starts the
 * sums over; null leaves the bar out and ends the running session. A session
 * has no value until it has traded volume.
 */
export function sessionVwap(
  bars: readonly StudyBar[],
  sessionOf: (bar: StudyBar, index: number) => number | null,
): VwapValue[] {
  const values: VwapValue[] = [];
  let session: number | null = null;
  let volume = 0;
  let priceVolume = 0;
  let squareVolume = 0;
  bars.forEach((bar, index) => {
    const key = sessionOf(bar, index);
    if (key === null) {
      session = null;
      return;
    }
    if (key !== session) {
      session = key;
      volume = 0;
      priceVolume = 0;
      squareVolume = 0;
    }
    const barVolume = Number.isFinite(bar.volume) && bar.volume > 0 ? bar.volume : 0;
    const price = typicalPrice(bar);
    volume += barVolume;
    priceVolume += price * barVolume;
    squareVolume += price * price * barVolume;
    if (volume <= 0) return;
    const value = priceVolume / volume;
    values.push({ index, value, deviation: Math.sqrt(Math.max(0, squareVolume / volume - value * value)) });
  });
  return values;
}

/**
 * VWAP from the bar that holds `anchorTime`, never reset: the first bar that
 * ends after it, a bar lasting `barMs` or until the next one opens. An anchor
 * picked on 5-minute bars still starts on its own day on daily bars, which
 * are stamped at the day's start.
 */
export function anchoredVwap(bars: readonly StudyBar[], anchorTime: number, barMs = 0): VwapValue[] {
  const start = bars.findIndex((bar, index) => (
    Math.min(bar.time + barMs, bars[index + 1]?.time ?? Number.POSITIVE_INFINITY) > anchorTime
    || bar.time >= anchorTime
  ));
  return sessionVwap(bars, (_bar, index) => start >= 0 && index >= start ? 0 : null);
}

/**
 * Wilder's average true range: the first value is the mean true range of the
 * first `period` bars (the first bar's range is its high less its low), then
 * each bar adds 1/period of its true range.
 */
export function averageTrueRange(
  bars: readonly StudyBar[],
  period: number,
): Array<{ index: number; value: number }> {
  if (period < 1 || bars.length < period) return [];
  const ranges = bars.map((bar, index) => {
    const previous = bars[index - 1];
    return previous
      ? Math.max(bar.high - bar.low, Math.abs(bar.high - previous.close), Math.abs(bar.low - previous.close))
      : bar.high - bar.low;
  });
  let current = ranges.slice(0, period).reduce((sum, range) => sum + range, 0) / period;
  const values = [{ index: period - 1, value: current }];
  for (let index = period; index < ranges.length; index += 1) {
    current = (current * (period - 1) + ranges[index]!) / period;
    values.push({ index, value: current });
  }
  return values;
}

interface VolumeProfileRow {
  low: number;
  high: number;
  volume: number;
  /** Inside the value area around the point of control. */
  valueArea: boolean;
}

export interface VolumeProfile {
  /** Equal price bands from the lowest low to the highest high, lowest first. */
  rows: VolumeProfileRow[];
  /** The row with the most volume. */
  pocIndex: number;
  /** Middle of the point-of-control row. */
  poc: number;
  maxVolume: number;
  totalVolume: number;
}

/**
 * Volume at price over `bars`: each bar spreads its volume evenly over its
 * high-low range, and a bar with no range puts it all at its close. The value
 * area starts at the point of control and takes the busier neighbouring row
 * (the upper one on a tie) until it holds `valueAreaShare` of the volume.
 */
export function volumeProfile(
  bars: readonly StudyBar[],
  rowCount: number,
  valueAreaShare = 0.7,
): VolumeProfile | null {
  const usable = bars.filter((bar) => (
    Number.isFinite(bar.high) && Number.isFinite(bar.low) && Number.isFinite(bar.close)
    && Number.isFinite(bar.volume) && bar.volume > 0
  ));
  if (usable.length === 0 || rowCount < 1) return null;
  const low = Math.min(...usable.map((bar) => Math.min(bar.low, bar.close)));
  const high = Math.max(...usable.map((bar) => Math.max(bar.high, bar.close)));
  const count = high > low ? Math.floor(rowCount) : 1;
  const step = (high - low) / count;
  const volumes = new Array<number>(count).fill(0);
  const rowOf = (price: number) => step > 0 ? Math.min(count - 1, Math.max(0, Math.floor((price - low) / step))) : 0;

  for (const bar of usable) {
    const barLow = Math.max(low, Math.min(bar.low, bar.high));
    const barHigh = Math.min(high, Math.max(bar.low, bar.high));
    if (!(barHigh > barLow)) {
      volumes[rowOf(bar.close)]! += bar.volume;
      continue;
    }
    for (let row = rowOf(barLow); row <= rowOf(barHigh); row += 1) {
      const overlap = Math.min(low + (row + 1) * step, barHigh) - Math.max(low + row * step, barLow);
      if (overlap > 0) volumes[row]! += bar.volume * overlap / (barHigh - barLow);
    }
  }

  const totalVolume = volumes.reduce((sum, volume) => sum + volume, 0);
  let pocIndex = 0;
  volumes.forEach((volume, row) => {
    if (volume > volumes[pocIndex]!) pocIndex = row;
  });
  const target = totalVolume * Math.min(1, Math.max(0, valueAreaShare));
  let bottom = pocIndex;
  let top = pocIndex;
  let inside = volumes[pocIndex]!;
  // A small tolerance keeps rounding from adding a row past the target.
  while (inside < target - totalVolume * 1e-9 && (bottom > 0 || top < count - 1)) {
    const below = bottom > 0 ? volumes[bottom - 1]! : -1;
    const above = top < count - 1 ? volumes[top + 1]! : -1;
    if (above >= below) inside += volumes[++top]!;
    else inside += volumes[--bottom]!;
  }

  return {
    rows: volumes.map((volume, row) => ({
      low: low + row * step,
      high: row === count - 1 ? high : low + (row + 1) * step,
      volume,
      valueArea: row >= bottom && row <= top,
    })),
    pocIndex,
    poc: low + (pocIndex + 0.5) * step,
    maxVolume: volumes[pocIndex]!,
    totalVolume,
  };
}
