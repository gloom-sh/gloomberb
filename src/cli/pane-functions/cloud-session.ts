import { apiClient } from "../../api-client";
import type { MarketContext } from "../types";

const CLOUD_PLUGIN_ID = "gloomberb-cloud";
const CLOUD_SESSION_KEYS = ["resume:session", "session"] as const;

interface PersistedCloudSession {
  sessionToken?: unknown;
}

export function resolvePersistedCloudSessionToken(
  context: Pick<MarketContext, "persistence">,
): string | null {
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
