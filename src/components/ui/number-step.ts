/** Decimal stepping on a zero-based increment grid, without binary rounding drift. */
function decimal(value: string | number): { units: bigint; places: number } | undefined {
  const text = String(value).trim();
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match || !`${match[2]}${match[3] ?? ""}` || !Number.isFinite(Number(text))) return;
  const exponent = Number(match[4] ?? 0);
  const places = (match[3]?.length ?? 0) - exponent;
  if (Math.abs(places) > 18 || text.length > 100) return;
  const units = BigInt(`${match[1] === "-" ? "-" : ""}${match[2] || "0"}${match[3] ?? ""}`);
  return places < 0 ? { units: units * 10n ** BigInt(-places), places: 0 } : { units, places };
}
function floorDivide(a: bigint, b: bigint): bigint { return a / b - (a < 0n && a % b !== 0n ? 1n : 0n); }
function ceilDivide(a: bigint, b: bigint): bigint { return -floorDivide(-a, b); }
function format(units: bigint, places: number): string {
  const digits = (units < 0n ? -units : units).toString().padStart(places + 1, "0");
  const text = places ? `${digits.slice(0, -places)}.${digits.slice(-places)}`.replace(/\.?0+$/, "") : digits;
  return `${units < 0n ? "-" : ""}${text}`;
}
export function stepNumber(value: string, direction: 1 | -1, step: number, min?: number, max?: number): string | undefined {
  const current = decimal(value === "" ? 0 : value), increment = decimal(step);
  const lower = min === undefined ? undefined : decimal(min), upper = max === undefined ? undefined : decimal(max);
  if (!current || !increment || increment.units <= 0n || min !== undefined && !lower || max !== undefined && !upper) return;
  const places = Math.max(current.places, increment.places, lower?.places ?? 0, upper?.places ?? 0);
  const scaled = (n: { units: bigint; places: number }) => n.units * 10n ** BigInt(places - n.places);
  const at = scaled(current), by = scaled(increment);
  let ticks = direction > 0 ? floorDivide(at, by) + 1n : ceilDivide(at, by) - 1n;
  const low = lower && ceilDivide(scaled(lower), by), high = upper && floorDivide(scaled(upper), by);
  if (low !== undefined && high !== undefined && low > high) return;
  if (low !== undefined && ticks < low) ticks = low;
  if (high !== undefined && ticks > high) ticks = high;
  const next = ticks * by;
  // A bound must not make a plus go down or a minus go up, except an empty field.
  if (value !== "" && (direction > 0 ? next <= at : next >= at)) return;
  const text = format(next, places), roundTrip = decimal(Number(text));
  if (!roundTrip || roundTrip.places > places || scaled(roundTrip) !== next) return;
  return text;
}

/** Smallest whole-number multiple, for brokers combining a step with whole quantities. */
export function wholeNumberStep(step: number): number | undefined {
  const value = decimal(step);
  if (!value || value.units <= 0n) return;
  let a = value.units, b = 10n ** BigInt(value.places);
  while (b) { const remainder = a % b; a = b; b = remainder; }
  const result = Number(value.units / a);
  return Number.isSafeInteger(result) ? result : undefined;
}

export function matchesNumberStep(value: number, step: number): boolean {
  const n = decimal(value), s = decimal(step);
  if (!n || !s || s.units <= 0n) return false;
  const places = Math.max(n.places, s.places);
  return n.units * 10n ** BigInt(places - n.places) % (s.units * 10n ** BigInt(places - s.places)) === 0n;
}
