import { apiClient } from "../../../api-client";
import { isAccessDenied } from "../../../api-client/errors";
import type {
  CloudInsiderSignalsParams,
  InsiderSignalCap,
  InsiderSignalRoleGroup,
  InsiderSignalSide,
  InsiderSignalsPayload,
} from "../../../api-client/insider-signals";
import { createPluginCache } from "../../../data/plugin-cache";
import type { HeadlessPaneApiClient } from "../../../types/plugin";
import { cachedCloudResource, loadCloudResource, unavailableOnServer, type CloudResource } from "../shared/cloud-resource";
import { CLOUD_SESSION_REQUIRED } from "../shared/research-cloud-session";

/** The windows the pane offers, in days; the server takes any from 1 to 90. */
export const INSIDER_SIGNAL_WINDOWS = [7, 30, 90] as const;
export const DEFAULT_INSIDER_SIGNAL_WINDOW = 30;
/** Companies the pane ranks: a ranking is read from the top, and the server scores every company anyway. */
const INSIDER_SIGNAL_PANE_ROWS = 100;
const INSIDER_SIGNALS_NOT_AVAILABLE = "Insider activity is not available yet.";

/** What a ranking reads: a side, a window, and the filters. */
export interface InsiderSignalsQuery {
  side: InsiderSignalSide;
  window: number;
  role: InsiderSignalRoleGroup;
  /** USD; 0 for any. */
  minValue: number;
  cluster: boolean;
  /** New positions on the buy side, whole stakes sold on the sell side. */
  position: boolean;
  cap: InsiderSignalCap | null;
}

export const DEFAULT_INSIDER_SIGNALS_QUERY: InsiderSignalsQuery = {
  side: "buy",
  window: DEFAULT_INSIDER_SIGNAL_WINDOW,
  role: "all",
  minValue: 0,
  cluster: false,
  position: false,
  cap: null,
};

/** The request for a query; what is at its default is left out. */
function insiderSignalsParams(query: InsiderSignalsQuery, limit: number): CloudInsiderSignalsParams {
  return {
    ...(query.side === "sell" ? { side: "sell" as const } : {}),
    window: query.window,
    limit,
    ...(query.role !== "all" ? { role: query.role } : {}),
    ...(query.minValue > 0 ? { minValue: query.minValue } : {}),
    ...(query.cluster ? { cluster: true } : {}),
    ...(query.position ? { position: query.side === "sell" ? "exited" as const : "new" as const } : {}),
    ...(query.cap ? { cap: query.cap } : {}),
  };
}

export const insiderSignalsCache = createPluginCache<InsiderSignalsPayload>({
  kind: "insider-signals",
  source: "gloom-cloud",
  // 2: sides, filters and structured signals (Linear: GLO-921).
  schemaVersion: 2,
  // Filings arrive through the day; the ranking moves with them, not with the market.
  policy: { staleMs: 5 * 60_000, expireMs: 2 * 86_400_000 },
});

const text = (value: unknown): value is string => typeof value === "string";
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** A payload the pane can draw; anything else is an error, never a ranking with holes. */
function validateInsiderSignals(payload: InsiderSignalsPayload): InsiderSignalsPayload {
  const valid = !!payload && finite(payload.window) && Array.isArray(payload.rows)
    && payload.rows.every((row) => !!row && text(row.ticker) && text(row.company) && finite(row.score)
      && Array.isArray(row.reasons) && row.reasons.every(text)
      && finite(row.insiders) && finite(row.value) && text(row.lastBuy) && Array.isArray(row.buyers));
  if (!valid) throw new Error("Insider activity could not be read.");
  return payload;
}

function cacheKey(query: InsiderSignalsQuery, limit: number): string {
  return [query.side, query.window, query.role, query.minValue, query.cluster ? 1 : 0, query.position ? 1 : 0, query.cap ?? "-", limit].join(":");
}

export function cachedInsiderSignals(query: InsiderSignalsQuery, limit = INSIDER_SIGNAL_PANE_ROWS): CloudResource<InsiderSignalsPayload> | null {
  return cachedCloudResource(insiderSignalsCache, cacheKey(query, limit), validateInsiderSignals);
}

export async function loadInsiderSignals(
  query: InsiderSignalsQuery,
  {
    limit = INSIDER_SIGNAL_PANE_ROWS,
    force = false,
    client = apiClient,
    signal,
  }: {
    limit?: number;
    force?: boolean;
    client?: Pick<HeadlessPaneApiClient, "getCloudSecInsiderSignals">;
    signal?: AbortSignal;
  } = {},
): Promise<CloudResource<InsiderSignalsPayload>> {
  return loadCloudResource(
    insiderSignalsCache,
    cacheKey(query, limit),
    () => client.getCloudSecInsiderSignals(insiderSignalsParams(query, limit), { signal }).catch((error: unknown) => {
      // A refused session is the pane's sign-in wall, keyed on the shared gate.
      if (isAccessDenied(error)) throw new Error(CLOUD_SESSION_REQUIRED, { cause: error });
      throw unavailableOnServer(error, INSIDER_SIGNALS_NOT_AVAILABLE);
    }),
    { force, validate: validateInsiderSignals },
  );
}
