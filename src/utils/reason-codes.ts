/**
 * Reason codes are a data service's words for a machine: why it has nothing
 * (NO_DATA, NOT_FOUND) or could not answer (UPSTREAM_ERROR, TIMEOUT). An
 * error built from such an answer often carries one as its whole message, or
 * after a symbol ("AAPL: UPSTREAM_ERROR"). Nothing shows one as it is: the
 * shared states, table bodies, pane footers and the CLI read text through
 * here, the one place a code becomes words.
 */

const BUSY = "the source is busy, try again shortly";
const NO_ANSWER = "the source did not answer";

/** What each code the data service sends means, as a clause. */
const CLAUSES: Readonly<Record<string, string>> = {
  UPSTREAM_ERROR: NO_ANSWER,
  SOURCE_REFUSED_STORED_COPY: NO_ANSWER,
  TIMEOUT: "the source timed out",
  RATE_LIMITED: BUSY,
  UPSTREAM_RATE_LIMIT: BUSY,
  NO_DATA: "no data",
  NOT_FOUND: "nothing found",
  BAD_MAPPING: "nothing found",
  UNSUPPORTED_RANGE: "not available for this range",
  PRO_REQUIRED: "needs Gloom Pro",
  STALE_HISTORY: "the source's history is behind",
  MALFORMED_HISTORY: "the source's history could not be read",
  HISTORY_RETENTION: "older than the history kept",
  AMBIGUOUS_TICKER: "the symbol is listed in several places, name the exchange",
  AMBIGUOUS_EXCHANGE: "the symbol is listed in several places, name the exchange",
};

// Capitals joined by underscores, the shape of every code the service sends but TIMEOUT.
const CODE_SHAPE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
// A known code, or a source's failure (YAHOO_RATE_LIMIT, ..._ERROR), inside a longer text.
const EMBEDDED_CODE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

/** Whether `text` is a reason code on its own (UPSTREAM_ERROR), not words. */
export function isReasonCode(text: string | null | undefined): boolean {
  const trimmed = text?.trim() ?? "";
  return Object.hasOwn(CLAUSES, trimmed) || CODE_SHAPE.test(trimmed);
}

/**
 * What a reason code says happened, as a clause to follow a colon or stand in
 * a footer: "the source did not answer". An unknown code reads as a failure.
 */
export function reasonCodeClause(code: string): string {
  const trimmed = code.trim();
  if (Object.hasOwn(CLAUSES, trimmed)) return CLAUSES[trimmed]!;
  if (/RATE_?LIMIT/.test(trimmed)) return BUSY;
  if (/TIMEOUT|TIMED_OUT/.test(trimmed)) return CLAUSES.TIMEOUT!;
  if (/NOT_FOUND$/.test(trimmed)) return CLAUSES.NOT_FOUND!;
  return NO_ANSWER;
}

function embeddedCode(token: string): boolean {
  return Object.hasOwn(CLAUSES, token) || /(?:_ERROR|RATE_?LIMIT)$/.test(token);
}

function withEmbeddedCodes(text: string): string {
  return text.replace(EMBEDDED_CODE, (token) => embeddedCode(token) ? reasonCodeClause(token) : token);
}

/**
 * Text fit to show as a state's title or a CLI error: a bare reason code as
 * a sentence ("The source did not answer."), a known code inside a longer
 * text as its clause ("AAPL: the source did not answer"), anything else as
 * it is.
 */
export function readableError(text: string): string {
  if (!isReasonCode(text)) return withEmbeddedCodes(text);
  const clause = reasonCodeClause(text);
  return `${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`;
}

/** The same for a footer status, which reads as a clause: "the source did not answer". */
export function readableStatus(text: string): string {
  return isReasonCode(text) ? reasonCodeClause(text) : withEmbeddedCodes(text);
}
