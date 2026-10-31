import { DataServiceUnreachableError, isNetworkFailure } from "../utils/network-failure";
import { wasAskedTwice } from "../api-client/errors";

// Registered, so a miss raised by another copy of this module (a plugin that
// resolved `gloomberb/market-data` from the source tree) is still recognized.
const PROVIDER_MISS_BRAND = Symbol.for("gloomberb.provider-miss");
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

/** A source has the listing's bars but not up to the present: it answered, just behind. */
export class StaleHistoryError extends ProviderMissError {
  constructor(message: string) {
    super(message);
    this.name = "StaleHistoryError";
  }
}

function isProviderMiss(error: unknown): error is ProviderMissError {
  return error instanceof ProviderMissError
    || (!!error && typeof error === "object" && PROVIDER_MISS_BRAND in error);
}

/**
 * A source that could not answer just now (rate limited, overloaded, timed
 * out) and may if asked again shortly. Unlike a miss, it says nothing about
 * whether what was asked for exists.
 */
export class ProviderBusyError extends Error {
  constructor(message = "The data service is busy", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderBusyError";
  }
}

export function isProviderBusy(error: unknown): error is ProviderBusyError {
  return error instanceof ProviderBusyError;
}

/** What a search its sources could not answer says, rather than that nothing matched. */
export const SEARCH_BUSY_MESSAGE = "Search is busy, try again in a moment.";
/** The code a structured answer (CLI `--json`, remote control) gives that failure. */
export const SEARCH_BUSY_CODE = "search_busy";

/** The reason a provider gave for a miss, or undefined when it gave none. */
export function providerMissReason(error: unknown): string | undefined {
  return isProviderMiss(error) ? error.reason : undefined;
}

/** Collects the latest reason across the providers of one request. */
export interface ProviderMissNote {
  reason?: string;
  /** True while every provider that failed said it found no listing; one that failed another way (a timeout) clears it. */
  notFound?: boolean;
  /** The last provider failure that was not a miss (a refused session, a rate limit, a timeout). */
  failure?: unknown;
}

export function noteProviderMiss(note: ProviderMissNote | undefined, error: unknown): void {
  if (!note) return;
  const reason = providerMissReason(error);
  if (reason) note.reason = reason;
  if (!isProviderMiss(error)) note.failure = error;
  note.notFound = note.notFound !== false && isProviderMiss(error) && error.notFound === true;
}

/** A provider answered with data the router could not use: whatever else is missing, the symbol exists. */
export function noteProviderAnswer(note: ProviderMissNote | undefined): void {
  if (note) note.notFound = false;
}

// A command may follow it with the listing search suggests: "Not a ticker: USD_NGN. Did you mean USDNGN=X (...)?"
const NOT_A_TICKER = /^Not a ticker: (.+?)\.(?= Did you mean |$)/;

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
 * What a read says when Gloom's data service answered that its source failed,
 * having been asked twice (`readListing`): the listing is not said to have no
 * data, since asked again in a moment it may. "for SYMBOL" closes the first
 * sentence, so a table's note can name several symbols in front of it.
 */
export function serviceDidNotAnswerMessage(symbol?: string): string {
  return `Gloom's data service did not answer${symbol ? ` for ${symbol}` : ""}. Try again in a moment.`;
}

/** The router's generic answer that no provider served a request, holding the failure behind it when a provider failed rather than missed. */
class NoProviderError extends Error {
  constructor(message: string, readonly failure: unknown) {
    super(message);
  }
}

/**
 * The router's final error when no provider answered. A reason a provider gave
 * replaces the generic wording, and so does the service's answer that no
 * listing exists for `symbol` ("Not a ticker"), a request that never reached
 * the data service, and a listing read the data service failed to answer twice
 * (`wasAskedTwice`, `serviceDidNotAnswerMessage`), each of which says that
 * rather than that no source has the symbol; any other failure, a 5xx on a read
 * that is not asked again among them, keeps the generic message.
 */
export function noProviderError(message: string, note: ProviderMissNote | undefined, symbol?: string): Error {
  if (note?.reason) return createProviderMiss(note.reason, note.reason);
  if (note?.notFound === true && symbol) return createProviderMiss(notATickerMessage(symbol), undefined, { notFound: true });
  if (isNetworkFailure(note?.failure)) {
    return note!.failure instanceof DataServiceUnreachableError ? note!.failure : new DataServiceUnreachableError(note!.failure);
  }
  if (wasAskedTwice(note?.failure)) return new NoProviderError(serviceDidNotAnswerMessage(symbol), note!.failure);
  return new NoProviderError(message, note?.failure);
}

/**
 * The router's answer that no source served a read because one failed (a
 * timeout, a rate limit, a refused session), not because none has it: asked
 * again shortly it may answer.
 */
export function isSourceFailure(error: unknown): boolean {
  return error instanceof NoProviderError && error.failure !== undefined;
}

/**
 * Whether a failed read means no source has what was asked for: a source's
 * miss, or the router's answer that none served it when none failed another
 * way. A refused session, a rate limit or a timeout is not, as asked again it may answer.
 */
export function isNoSourceAnswer(error: unknown): boolean {
  if (isProviderMiss(error)) return true;
  if (error instanceof NoProviderError) return error.failure === undefined;
  return error instanceof Error && !(error instanceof ProviderBusyError) && isNoProviderMessage(error.message);
}

export function shouldLogProviderError(error: unknown): boolean {
  if (isProviderMiss(error)) return false;
  const message = error instanceof Error ? error.message : String(error);
  return !EXPECTED_PROVIDER_MISS.test(message);
}
