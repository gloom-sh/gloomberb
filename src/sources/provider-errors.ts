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
  /** The service found no listing for the symbol: it is not a ticker, which differs from a ticker it has no data for. */
  readonly notFound: boolean;

  constructor(message = "Provider could not satisfy request", reason?: unknown, options: { notFound?: boolean } = {}) {
    super(message);
    this.name = "ProviderMissError";
    this.reason = cleanProviderReason(reason);
    this.notFound = options.notFound === true;
  }
}

export function createProviderMiss(message?: string, reason?: unknown, options?: { notFound?: boolean }): ProviderMissError {
  return new ProviderMissError(message, reason, options);
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
  /** True while every provider that failed said it found no listing; one that failed another way (a timeout) clears it. */
  notFound?: boolean;
}

export function noteProviderMiss(note: ProviderMissNote | undefined, error: unknown): void {
  if (!note) return;
  const reason = providerMissReason(error);
  if (reason) note.reason = reason;
  note.notFound = note.notFound !== false && isProviderMiss(error) && error.notFound === true;
}

/** A provider answered with data the router could not use: whatever else is missing, the symbol exists. */
export function noteProviderAnswer(note: ProviderMissNote | undefined): void {
  if (note) note.notFound = false;
}

const NOT_A_TICKER = /^Not a ticker: (.+)\.$/;

/** "Not a ticker: APPLE.", what a request for a symbol no listing carries ends in. */
function notATickerMessage(symbol: string): string {
  return `Not a ticker: ${symbol}.`;
}

/** The symbol of a "Not a ticker: APPLE." message, or null for any other text. */
export function notATickerSymbol(message: string): string | null {
  return NOT_A_TICKER.exec(message.split("\n")[0] ?? "")?.[1] ?? null;
}

/**
 * Whether a message is the router's answer that no source serves a symbol: "No history provider
 * available for 2222", or "Not a ticker: 2222." when the service found no listing for it.
 * A timeout or any other failure is not.
 */
export function isNoProviderMessage(message: string): boolean {
  return /\bprovider available for\b/i.test(message) || notATickerSymbol(message) !== null;
}

/**
 * The router's final error when no provider answered. A reason a provider gave
 * replaces the generic wording, and so does the service's answer that no
 * listing exists for `symbol` ("Not a ticker"); a timeout or any other failure
 * keeps the generic message.
 */
export function noProviderError(message: string, note: ProviderMissNote | undefined, symbol?: string): Error {
  if (note?.reason) return createProviderMiss(note.reason, note.reason);
  if (note?.notFound === true && symbol) return createProviderMiss(notATickerMessage(symbol), undefined, { notFound: true });
  return new Error(message);
}

export function shouldLogProviderError(error: unknown): boolean {
  if (isProviderMiss(error)) return false;
  const message = error instanceof Error ? error.message : String(error);
  return !EXPECTED_PROVIDER_MISS.test(message);
}
