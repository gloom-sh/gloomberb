import { expect, setSystemTime, test } from "bun:test";
import type { PluginConfigState } from "../../../../types/plugin";
import { debugLog } from "../../../../utils/debug-log";
import { loadNewsFeedSettings } from "./feed-config";

test("unreadable feed settings retain the empty fallback and log no stored content", () => {
  const stored = new Map<string, unknown>([
    ["feeds", '[{"name":"private-title","url":"https://example.test/?token=private-token"}'],
  ]);
  const config: PluginConfigState = {
    get: <T,>(key: string) => (stored.get(key) as T | undefined) ?? null,
    set: async (key, value) => { stored.set(key, value); },
    delete: async (key) => { stored.delete(key); },
    keys: () => [...stored.keys()],
  };
  const source = "news.feed-config";
  const start = debugLog.getEntries({ source }).length;
  setSystemTime(new Date("2040-01-01T00:00:00Z"));
  try {
    const expected = { userFeeds: [], disabledDefaultFeedIds: [], needsMigration: true };
    expect(loadNewsFeedSettings(config)).toEqual(expected);
    expect(loadNewsFeedSettings(config)).toEqual(expected);
    const entries = debugLog.getEntries({ source }).slice(start);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      source,
      level: "warn",
      message: "Read stored news feed settings failed",
      data: undefined,
    });
    expect(JSON.stringify(entries)).not.toContain("private");
  } finally {
    setSystemTime();
  }
});
