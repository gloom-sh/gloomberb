
type ProviderStatus = "success" | "partial" | "empty" | "unsupported" | "retryable_error" | "fatal_error";

export type ProviderReasonCode =
  | "NO_DATA"
  | "NOT_FOUND"
  | "TIMEOUT"
  | "UNSUPPORTED_RANGE"
  | "BAD_MAPPING"
  | "UPSTREAM_ERROR";

export interface ProviderAttempt {
  providerId: string;
  status: ProviderStatus;
  startedAt: number;
  finishedAt: number;
  latencyMs: number;
  reasonCode?: ProviderReasonCode;
  message?: string;
}

type QueryPhase = "idle" | "loading" | "ready" | "refreshing" | "error";

export interface QueryEntry<T> {
  phase: QueryPhase;
  data: T | null;
  lastGoodData: T | null;
  source: string | null;
  /** Chart-only provenance paired with resolved data, including retained lastGoodData. */
  history?: Omit<import("../types/price-history").PriceHistoryResult, "points">;
  fetchedAt: number | null;
  /** Accepted source response order in this runtime, preserved through cache projections. */
  responseSequence?: number;
  asOf?: number;
  /** Exchange rates: how far the snapshot runs behind the market, in minutes; 0 for a real-time one. */
  delayMinutes?: number;
  staleAt: number | null;
  error: { reasonCode: string; message: string } | null;
  attempts: ProviderAttempt[];
}

export function createIdleEntry<T>(): QueryEntry<T> {
  return {
    phase: "idle",
    data: null,
    lastGoodData: null,
    source: null,
    fetchedAt: null,
    staleAt: null,
    error: null,
    attempts: [],
  };
}
