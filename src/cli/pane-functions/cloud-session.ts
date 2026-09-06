import { apiClient } from "../../api-client";
import type { MarketContext } from "../types";

const CLOUD_PLUGIN_ID = "gloomberb-cloud";
const CLOUD_SESSION_KEYS = ["resume:session", "session"] as const;

interface PersistedCloudSession {
  sessionToken?: unknown;
}

/**
 * A container has no local plugin state, so a bot or a CI job has no way to
 * reach Pro gated panes. `GLOOMBERB_SESSION_TOKEN` gives headless callers the
 * same session the desktop app persists after signing in, and it wins over the
 * stored one so a service account can be pointed somewhere else without
 * touching the user's own state.
 */
export function resolvePersistedCloudSessionToken(
  context: Pick<MarketContext, "persistence">,
): string | null {
  const fromEnv = process.env.GLOOMBERB_SESSION_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  for (const key of CLOUD_SESSION_KEYS) {
    const value = context.persistence.pluginState.get<PersistedCloudSession>(
      CLOUD_PLUGIN_ID,
      key,
      1,
    )?.value;
    if (typeof value?.sessionToken === "string" && value.sessionToken.length > 0) {
      return value.sessionToken;
    }
  }
  return null;
}

export async function withPersistedCloudSession<T>(
  context: Pick<MarketContext, "persistence">,
  run: () => Promise<T>,
): Promise<T> {
  const previousSessionToken = apiClient.getSessionToken();
  apiClient.setSessionToken(resolvePersistedCloudSessionToken(context));
  try {
    return await run();
  } finally {
    apiClient.setSessionToken(previousSessionToken);
  }
}
