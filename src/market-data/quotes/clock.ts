/**
 * Quote timestamps are stamped by the exchange and the server; the freshness
 * gates compare them with this machine's clock. A clock running a little
 * behind would otherwise make every fresh tick look like it came from the
 * future and drop it, so a bounded amount of future time is tolerated. The
 * bound grows with the server offset measured from socket frames.
 */
const MIN_FUTURE_TOLERANCE_MS = 2_000;
const OFFSET_MARGIN_MS = 1_000;
// Far-future stamps are still malformed data, whatever the measured offset.
const MAX_FUTURE_TOLERANCE_MS = 60 * 60_000;
const OFFSET_SAMPLE_LIMIT = 32;

const samples: number[] = [];
let measuredOffsetMs: number | null = null;
let forwardedOffsetMs: number | null = null;

/**
 * Records one server-stamped frame. Network delay can only make the sample
 * smaller than the true offset, so the largest recent sample is the best
 * estimate of how far the server clock runs ahead of this one.
 */
export function recordServerClockSample(serverTimeMs: unknown, receivedAtMs = Date.now()): void {
  if (typeof serverTimeMs !== "number" || !Number.isFinite(serverTimeMs) || serverTimeMs <= 0) return;
  if (!Number.isFinite(receivedAtMs)) return;
  samples.push(serverTimeMs - receivedAtMs);
  if (samples.length > OFFSET_SAMPLE_LIMIT) samples.shift();
  let max = Number.NEGATIVE_INFINITY;
  for (const sample of samples) max = Math.max(max, sample);
  measuredOffsetMs = max;
}

/** An offset measured by another process on this machine (the desktop backend owns the socket). */
export function setForwardedServerClockOffset(offsetMs: unknown): void {
  forwardedOffsetMs = typeof offsetMs === "number" && Number.isFinite(offsetMs) ? offsetMs : null;
}

/** Server clock minus local clock in ms, or null before any server-stamped frame. */
export function getServerClockOffsetMs(): number | null {
  if (measuredOffsetMs == null) return forwardedOffsetMs;
  if (forwardedOffsetMs == null) return measuredOffsetMs;
  return Math.max(measuredOffsetMs, forwardedOffsetMs);
}

/** How far ahead of local time a quote timestamp may be and still count as observed. */
export function quoteFutureToleranceMs(): number {
  const offset = getServerClockOffsetMs();
  const tolerance = offset == null ? MIN_FUTURE_TOLERANCE_MS : Math.max(MIN_FUTURE_TOLERANCE_MS, offset + OFFSET_MARGIN_MS);
  return Math.min(tolerance, MAX_FUTURE_TOLERANCE_MS);
}

export function resetServerClockForTests(): void {
  samples.length = 0;
  measuredOffsetMs = null;
  forwardedOffsetMs = null;
}
