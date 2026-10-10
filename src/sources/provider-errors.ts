const PROVIDER_MISS_BRAND = Symbol("provider-miss");
const EXPECTED_PROVIDER_MISS = /No data found|symbol may be delisted|"code":"Not Found"|No history for /i;

const MAX_REASON_LENGTH = 200;
// Whole ANSI sequences go first, so their printable tail does not outlive the escape byte.
const ANSI_SEQUENCE = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?)/g;
const LINE_BREAKS = /[\r\n\t\v\f\u0085\u2028\u2029]+/g;
// Remaining controls, and the bidirectional overrides that can reorder text in a terminal.
const CONTROL_CHARACTERS = /[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/**
 * A reason a data service wrote for an empty answer, made safe to show: one
 * line, no control characters, at most 200 characters. Anything that is not a
 * non-empty string has no reason.
 */
export function cleanProviderReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value.replace(ANSI_SEQUENCE, "").replace(LINE_BREAKS, " ").replace(CONTROL_CHARACTERS, "").replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  const characters = Array.from(line);
  return characters.length > MAX_REASON_LENGTH
    ? `${characters.slice(0, MAX_REASON_LENGTH - 1).join("").trimEnd()}…`
    : line;
}

export class ProviderMissError extends Error {
  readonly [PROVIDER_MISS_BRAND] = true;
  /** Why the service has nothing, in its own words, when it said. */
  readonly reason?: string;

  constructor(message = "Provider could not satisfy request", reason?: unknown) {
    super(message);
    this.name = "ProviderMissError";
    this.reason = cleanProviderReason(reason);
  }
}

export function createProviderMiss(message?: string, reason?: unknown): ProviderMissError {
  return new ProviderMissError(message, reason);
}

function isProviderMiss(error: unknown): error is ProviderMissError {
  return error instanceof ProviderMissError
    || (!!error && typeof error === "object" && PROVIDER_MISS_BRAND in error);
}

/** The reason a provider gave for a miss, or undefined when it gave none. */
export function providerMissReason(error: unknown): string | undefined {
  return isProviderMiss(error) ? error.reason : undefined;
}

/** Collects the latest reason across the providers of one request. */
export interface ProviderMissNote {
  reason?: string;
}

export function noteProviderMiss(note: ProviderMissNote | undefined, error: unknown): void {
  const reason = providerMissReason(error);
  if (note && reason) note.reason = reason;
}

/**
 * The router's final error when no provider answered. A reason a provider gave
 * replaces the generic wording; without one the generic message stays.
 */
export function noProviderError(message: string, note: ProviderMissNote | undefined): Error {
  return note?.reason ? createProviderMiss(note.reason, note.reason) : new Error(message);
}

export function shouldLogProviderError(error: unknown): boolean {
  if (isProviderMiss(error)) return false;
  const message = error instanceof Error ? error.message : String(error);
  return !EXPECTED_PROVIDER_MISS.test(message);
}
