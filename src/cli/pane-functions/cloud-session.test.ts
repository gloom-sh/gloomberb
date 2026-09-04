import { describe, expect, test } from "bun:test";
import { apiClient } from "../../api-client";
import type { MarketContext } from "../types";
import {
  resolvePersistedCloudSessionToken,
  withPersistedCloudSession,
} from "./cloud-session";

function contextWithSession(
  key: string,
  sessionToken: string,
): Pick<MarketContext, "persistence"> {
  return {
    persistence: {
      pluginState: {
        get: (_pluginId: string, candidate: string) => candidate === key
          ? { value: { sessionToken }, schemaVersion: 1, updatedAt: 1 }
          : null,
      },
    },
  } as Pick<MarketContext, "persistence">;
}

describe("pane function Cloud session", () => {
  test("restores the current and legacy persisted session keys", () => {
    expect(resolvePersistedCloudSessionToken(
      contextWithSession("resume:session", "current-session"),
    )).toBe("current-session");
    expect(resolvePersistedCloudSessionToken(
      contextWithSession("session", "legacy-session"),
    )).toBe("legacy-session");
  });

  test("scopes the persisted session to one report load", async () => {
    const initial = apiClient.getSessionToken();
    apiClient.setSessionToken("previous-session");
    try {
      let activeSession: string | null = null;
      const result = await withPersistedCloudSession(
        contextWithSession("resume:session", "report-session"),
        async () => {
          activeSession = apiClient.getSessionToken();
          return 42;
        },
      );

      expect(result).toBe(42);
      expect(activeSession).toBe("report-session");
      expect(apiClient.getSessionToken()).toBe("previous-session");
    } finally {
      apiClient.setSessionToken(initial);
    }
  });
});
