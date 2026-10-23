import type { ScreenCheckPayload, ScreenCriterion, ScreenDefinition } from "../../../api-client/equity-screener";
import { canonicalExchange, parsePublicTickerKey } from "../../../utils/exchanges";
import { criterionText, parseScreenDefinition, screenDefinitionKey, screenLabel } from "./model";

/** One listing, with the same exchange aliases the rest of the app accepts. */
export function screenCheckTicker(text: string): { symbol: string; exchange?: string } {
  const ticker = parsePublicTickerKey(text.trim());
  if (!/^[A-Z0-9][A-Z0-9./-]{0,31}$/.test(ticker.symbol)
    || (ticker.exchange !== undefined && !/^[A-Z0-9_-]{1,24}$/.test(ticker.exchange)))
    throw new Error("Enter one ticker, such as NVDA or NVDA:NASDAQ.");
  return ticker;
}

const dated = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const nullableText = (value: unknown) => value === null || typeof value === "string";
// Stored equity listings share one identity across share-class separators.
const listingSymbol = (symbol: string) => symbol.replace(/[./]/g, "-");

/** Reject a response for another definition, listing or snapshot before showing its verdict. */
export function validateScreenCheck(
  value: unknown,
  definition: ScreenDefinition,
  ticker: { symbol: string; exchange?: string },
  snapshotId?: string,
): ScreenCheckPayload {
  const data = value as ScreenCheckPayload;
  const invalid = () => new Error("Invalid ticker check response. Refresh the screen and try again.");
  if (!data || data.version !== 1 || !["available", "partial", "not-covered"].includes(data.status)
    || data.symbol !== ticker.symbol || !Array.isArray(data.criteria)
    || !Array.isArray(data.warnings) || data.warnings.some((warning) => typeof warning !== "string")
    || !data.snapshot || typeof data.snapshot.id !== "string"
    || !dated(data.snapshot.assembledAt) || !dated(data.snapshot.expiresAt)
    || Date.parse(data.snapshot.expiresAt) <= Date.parse(data.snapshot.assembledAt)
    || (snapshotId !== undefined && data.snapshot.id !== snapshotId)) throw invalid();
  if (screenDefinitionKey(data.definition) !== screenDefinitionKey(definition)) throw invalid();
  const expected: ScreenCriterion[] = [
    ...(definition.currency ? [{ field: "currency", op: "in", value: [definition.currency] } as ScreenCriterion] : []),
    ...parseScreenDefinition(definition).criteria,
  ];
  if (data.criteria.length !== expected.length) throw invalid();
  const covered = data.status !== "not-covered";
  if (covered) {
    if (!data.row || typeof data.row.symbol !== "string" || listingSymbol(data.row.symbol) !== listingSymbol(ticker.symbol) || typeof data.row.exchange !== "string"
      || (ticker.exchange && canonicalExchange(data.row.exchange) !== ticker.exchange)
      || ![data.row.name, data.row.currency, data.row.sector, data.row.industry].every(nullableText)
      || typeof data.matches !== "boolean") throw invalid();
  } else if (data.row !== null || data.matches !== null) throw invalid();
  for (let i = 0; i < expected.length; i++) {
    const entry = data.criteria[i]!;
    if (!entry || typeof entry.implicit !== "boolean" || entry.implicit !== (i === 0 && !!definition.currency)
      || !["available", "partial", "stale", "unavailable", "missing", "not-covered"].includes(entry.state)
      || typeof entry.unit !== "string" || !nullableText(entry.reason)
      || (entry.asOf !== null && !dated(entry.asOf))
      || (entry.observedAt !== null && !dated(entry.observedAt))
      || (entry.value !== null && typeof entry.value !== "string" && (typeof entry.value !== "number" || !Number.isFinite(entry.value)))
      || (covered ? typeof entry.passes !== "boolean" : entry.passes !== null || entry.value !== null || entry.state !== "not-covered")) throw invalid();
    // Parsing normalizes object key order and category lists on both sides.
    const one = (criterion: ScreenCriterion) => screenDefinitionKey({ ...definition, criteria: [criterion] });
    if (one(entry.criterion) !== one(expected[i]!)) throw invalid();
  }
  if (covered && data.matches !== data.criteria.every((entry) => entry.passes)) throw invalid();
  return data;
}

const number = (value: number) => value.toLocaleString("en-US", { maximumSignificantDigits: 21 });
function checkCriterionText(criterion: ScreenCriterion): string {
  if (!("value" in criterion) || criterion.op === "in") return criterionText(criterion);
  const operators = { gte: ">=", lte: "<=", gt: ">", lt: "<", eq: "=", between: "between" };
  const threshold = Array.isArray(criterion.value) ? criterion.value.map(number).join(", ") : number(criterion.value);
  return `${screenLabel(criterion.field)} ${operators[criterion.op]} ${threshold}`;
}

/** The verdict uses stored screening values, never the live quote overlaid on Results. */
export function screenCheckSummary(data: ScreenCheckPayload): string {
  return data.matches === null ? "Not covered" : data.matches ? "Passes all criteria" : "Does not match";
}

export function checkRows(data: ScreenCheckPayload) {
  return data.criteria.map((entry, index) => ({
    id: String(index),
    criterion: checkCriterionText(entry.criterion),
    value: entry.state === "not-covered" ? "Not covered" : entry.value === null ? "Missing" : typeof entry.value === "number"
      ? `${number(entry.value)}${entry.unit ? ` ${entry.unit}` : ""}` : entry.value,
    result: entry.passes === null ? "Not evaluated" : entry.passes ? "Pass" : "Fail",
    asOf: entry.asOf?.slice(0, 10) ?? (entry.observedAt ? `${entry.observedAt.slice(0, 10)} (collected)` : "--"),
    state: entry.state,
    reason: entry.reason,
    passes: entry.passes,
  }));
}
