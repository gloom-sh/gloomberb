import { apiClient } from "../../../api-client";
import { isAccessDenied } from "../../../api-client/errors";
import type { InsiderSignalsPayload } from "../../../api-client/insider-signals";
import { createPluginCache } from "../../../data/plugin-cache";
import type { HeadlessPaneApiClient } from "../../../types/plugin";
import { cachedCloudResource, loadCloudResource, unavailableOnServer, type CloudResource } from "../shared/cloud-resource";
import { CLOUD_SESSION_REQUIRED } from "../shared/research-cloud-session";

/** The windows the pane offers, in days; the server takes any from 1 to 90. */
export const INSIDER_SIGNAL_WINDOWS = [7, 30, 90] as const;
export const DEFAULT_INSIDER_SIGNAL_WINDOW = 30;
/** Companies the pane ranks: a ranking is read from the top, and the server scores every company anyway. */
const INSIDER_SIGNAL_PANE_ROWS = 100;
const INSIDER_SIGNALS_NOT_AVAILABLE = "Insider buying is not available yet.";

export const insiderSignalsCache = createPluginCache<InsiderSignalsPayload>({
  kind: "insider-signals",
  source: "gloom-cloud",
  schemaVersion: 1,
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
  if (!valid) throw new Error("Insider buying could not be read.");
  return payload;
}

function cacheKey(window: number, limit: number): string {
  return `${window}:${limit}`;
}

export function cachedInsiderSignals(window: number, limit = INSIDER_SIGNAL_PANE_ROWS): CloudResource<InsiderSignalsPayload> | null {
  return cachedCloudResource(insiderSignalsCache, cacheKey(window, limit), validateInsiderSignals);
}

export async function loadInsiderSignals(
  window: number,
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
    cacheKey(window, limit),
    () => client.getCloudSecInsiderSignals({ window, limit }, { signal }).catch((error: unknown) => {
      // A refused session is the pane's sign-in wall, keyed on the shared gate.
      if (isAccessDenied(error)) throw new Error(CLOUD_SESSION_REQUIRED, { cause: error });
      throw unavailableOnServer(error, INSIDER_SIGNALS_NOT_AVAILABLE);
    }),
    { force, validate: validateInsiderSignals },
  );
}
