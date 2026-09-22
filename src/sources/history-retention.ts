import { canonicalExchange, parsePublicTickerKey } from "../utils/exchanges";

export const HISTORY_RETENTION_MAX_AGE_MS = 5 * 60_000;
// The record carries the server's clock; the server revalidates it on retry.
const HISTORY_RETENTION_CLOCK_SKEW_MS = 5 * 60_000;

/** A source-proven Yahoo retention boundary, not an inferred range failure. */
export interface HistoryRetention {
  readonly version: 1;
  readonly source: "yahoo";
  readonly symbol: string;
  readonly exchange: string;
  readonly interval: string;
  readonly requestedStart: number;
  readonly requestedEnd: number;
  readonly observedAt: number;
  readonly availableStart: number;
}

export interface HistoryRecoveryRequest {
  readonly symbol: string;
  readonly exchange: string;
  readonly entityKey: string;
  readonly brokerId?: string;
  readonly brokerInstanceId?: string;
  readonly interval: string;
  readonly requestedStart: number;
  readonly requestedEnd: number;
}

export interface HistoryRecoveryCandidate {
  readonly sourceKey: string;
  readonly request: HistoryRecoveryRequest;
  readonly retention: HistoryRetention;
}

export type HistorySourceOutcomeKind = "success" | "retention" | "auth" | "rate-limit" | "transient" | "failure"
  | "empty" | "missing-method" | "stale" | "malformed" | "reported-gaps" | "timeout" | "coverage";
export interface HistorySourceOutcome {
  readonly sourceKey: string;
  readonly outcome: HistorySourceOutcomeKind;
  readonly status?: number;
}

const outcomes = new Set<HistorySourceOutcomeKind>(["success", "retention", "auth", "rate-limit", "transient", "failure", "empty",
  "missing-method", "stale", "malformed", "reported-gaps", "timeout", "coverage"]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 256): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\r\n\0]/.test(value);
const instant = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 8_640_000_000_000_000;
const yahooRetentionIntervals = new Set(["1min", "5min", "15min", "30min", "1h"]);

export function canonicalHistoryInterval(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hour|hours|d|day|days|w|wk|week|weeks|mo|month|months)$/i.exec(value.trim());
  if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) <= 0) return null;
  const unit = match[2]!.toLowerCase();
  return `${Number(match[1])}${/^(mo|month)/.test(unit) ? "month" : /^(w|wk|week)/.test(unit) ? "week" : /^(d|day)/.test(unit) ? "day" : /^(h|hr|hour)/.test(unit) ? "h" : "min"}`;
}

export function parseHistoryRetention(value: unknown, now = Date.now()): HistoryRetention | null {
  if (!object(value) || value.version !== 1 || value.source !== "yahoo"
    || !text(value.symbol) || typeof value.exchange !== "string" || value.exchange.length > 256
    || !instant(value.requestedStart) || !instant(value.requestedEnd)
    || !instant(value.observedAt) || !instant(value.availableStart)) return null;
  const interval = canonicalHistoryInterval(value.interval);
  const target = parsePublicTickerKey(value.symbol);
  const exchange = canonicalExchange(value.exchange);
  const retentionDays = (value.observedAt - value.availableStart) / 86_400_000;
  if (!interval || !yahooRetentionIntervals.has(interval) || !Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 730
    || target.exchange || target.symbol !== value.symbol
    || exchange !== value.exchange || value.requestedStart >= value.availableStart
    || value.requestedStart >= value.requestedEnd || value.availableStart > value.observedAt
    || value.observedAt > now + HISTORY_RETENTION_CLOCK_SKEW_MS || now - value.observedAt > HISTORY_RETENTION_MAX_AGE_MS
    || [value.requestedStart, value.requestedEnd, value.observedAt, value.availableStart].some((time) => time % 1000 !== 0)) return null;
  return Object.freeze({ version: 1, source: "yahoo", symbol: target.symbol, exchange, interval,
    requestedStart: value.requestedStart, requestedEnd: value.requestedEnd,
    observedAt: value.observedAt, availableStart: value.availableStart });
}

export function parseHistoryRecoveryCandidate(value: unknown, now = Date.now()): HistoryRecoveryCandidate | null {
  if (!object(value) || !text(value.sourceKey) || !value.sourceKey.startsWith("provider:")
    || value.sourceKey.length <= "provider:".length || !object(value.request)) return null;
  const retention = parseHistoryRetention(value.retention, now), request = value.request;
  if (!retention || retention.availableStart >= retention.requestedEnd || !text(request.entityKey, 8192)
    || request.symbol !== retention.symbol || request.exchange !== retention.exchange
    || canonicalHistoryInterval(request.interval) !== retention.interval || request.requestedStart !== retention.requestedStart
    || request.requestedEnd !== retention.requestedEnd || (request.brokerId !== undefined && !text(request.brokerId))
    || (request.brokerInstanceId !== undefined && !text(request.brokerInstanceId))) return null;
  return Object.freeze({ sourceKey: value.sourceKey, retention, request: Object.freeze({
    symbol: retention.symbol, exchange: retention.exchange, entityKey: request.entityKey,
    ...(request.brokerId !== undefined ? { brokerId: request.brokerId } : {}),
    ...(request.brokerInstanceId !== undefined ? { brokerInstanceId: request.brokerInstanceId } : {}),
    interval: retention.interval, requestedStart: retention.requestedStart, requestedEnd: retention.requestedEnd,
  }) });
}

function parseOutcome(value: unknown): HistorySourceOutcome | null {
  if (!object(value) || !text(value.sourceKey) || !/^(provider|broker):.+/.test(value.sourceKey)
    || !outcomes.has(value.outcome as HistorySourceOutcomeKind)
    || (value.status !== undefined && (!Number.isInteger(value.status) || Number(value.status) < 100 || Number(value.status) > 599))) return null;
  return Object.freeze({ sourceKey: value.sourceKey, outcome: value.outcome as HistorySourceOutcomeKind,
    ...(value.status !== undefined ? { status: value.status as number } : {}) });
}

export class HistoryRetentionError extends Error {
  readonly retention: HistoryRetention;
  readonly candidates: readonly HistoryRecoveryCandidate[];
  readonly outcomes: readonly HistorySourceOutcome[];

  constructor(retention: HistoryRetention, routing: {
    candidates?: readonly HistoryRecoveryCandidate[];
    outcomes?: readonly HistorySourceOutcome[];
  } = {}) {
    super("Requested history precedes the source retention window");
    this.name = "HistoryRetentionError";
    const parsed = parseHistoryRetention(retention);
    const candidates = (routing.candidates ?? []).map((candidate) => parseHistoryRecoveryCandidate(candidate));
    const sourceOutcomes = (routing.outcomes ?? []).map(parseOutcome);
    if (!parsed || candidates.some((candidate) => !candidate) || sourceOutcomes.some((outcome) => !outcome)
      || new Set(candidates.map((candidate) => candidate?.sourceKey)).size !== candidates.length
      || new Set(sourceOutcomes.map((outcome) => outcome?.sourceKey)).size !== sourceOutcomes.length
      || candidates.some((candidate) => candidate && (candidate.retention.symbol !== parsed.symbol
        || candidate.retention.exchange !== parsed.exchange || candidate.retention.interval !== parsed.interval
        || candidate.request.entityKey !== candidates[0]?.request.entityKey
        || candidate.request.brokerId !== candidates[0]?.request.brokerId
        || candidate.request.brokerInstanceId !== candidates[0]?.request.brokerInstanceId
        || !sourceOutcomes.some((outcome) => outcome?.sourceKey === candidate.sourceKey && outcome.outcome === "retention")))) {
      throw new Error("Invalid history retention metadata");
    }
    this.retention = parsed;
    this.candidates = Object.freeze(candidates as HistoryRecoveryCandidate[]);
    this.outcomes = Object.freeze(sourceOutcomes as HistorySourceOutcome[]);
    Object.freeze(this);
  }
}

export function isHistoryRetentionError(value: unknown): value is HistoryRetentionError {
  return value instanceof HistoryRetentionError && parseHistoryRetention(value.retention) !== null;
}

/** Validate again after crossing the desktop JSON boundary. */
export function parseHistoryRetentionError(value: unknown): HistoryRetentionError | null {
  if (!object(value) || !Array.isArray(value.candidates) || value.candidates.length > 100
    || !Array.isArray(value.outcomes) || value.outcomes.length > 200) return null;
  const retention = parseHistoryRetention(value.retention);
  if (!retention) return null;
  try {
    return new HistoryRetentionError(retention, {
      candidates: value.candidates as HistoryRecoveryCandidate[], outcomes: value.outcomes as HistorySourceOutcome[],
    });
  } catch { return null; }
}
