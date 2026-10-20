import { expect, mock, setSystemTime, test } from "bun:test";
import type { PluginConfigState } from "../../../../types/plugin";
import { debugLog } from "../../../../utils/debug-log";
import { DEFAULT_FEEDS } from "./default-feeds";
import {
  addUserNewsFeed,
  createUserFeed,
  getEnabledNewsFeeds,
  loadNewsFeedSettings,
  removeUserNewsFeed,
  saveNewsFeedSettings,
  setDefaultNewsFeedEnabled,
  updateUserNewsFeed,
} from "./feed-config";

const UNREADABLE = '[{"name":"private-title","url":"https://example.test/?token=private-token"}';
const ERROR = "News feed settings could not be read. Saved settings were kept.";
const FEED = createUserFeed({ id: "saved", name: "Saved feed", url: "https://example.test/rss" });

function configFixture(values: Record<string, unknown>) {
  const stored = new Map(Object.entries(values));
  const config: PluginConfigState = {
    get: <T,>(key: string) => (stored.get(key) as T | undefined) ?? null,
    set: mock(async (key: string, value: unknown) => { stored.set(key, value); }),
    delete: async (key) => { stored.delete(key); },
    keys: () => [...stored.keys()],
  };
  return { config, stored };
}

test("unreadable feed settings stop migration and log no stored content", () => {
  const { config } = configFixture({ feeds: UNREADABLE });
  const source = "news.feed-config";
  const start = debugLog.getEntries({ source }).length;
  setSystemTime(new Date("2040-01-01T00:00:00Z"));
  try {
    const expected = { userFeeds: [], disabledDefaultFeedIds: [], needsMigration: false, error: ERROR };
    expect(loadNewsFeedSettings(config)).toEqual(expected);
    expect(loadNewsFeedSettings(config)).toEqual(expected);
    const entries = debugLog.getEntries({ source }).slice(start);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      source,
      level: "warn",
      message: expect.stringMatching(/^Read stored news feed settings failed(?: \(suppressed repeats: \d+\))?$/),
      data: undefined,
    });
    expect(JSON.stringify(entries)).not.toContain("private");
  } finally {
    setSystemTime();
  }
});

for (const key of ["feeds", "disabledDefaultFeedIds"]) {
  test(`${key}: every feed write refuses unreadable settings without changing either value`, async () => {
    const original = {
      feeds: JSON.stringify([FEED]),
      disabledDefaultFeedIds: JSON.stringify(DEFAULT_FEEDS.map((feed) => feed.id)),
      [key]: UNREADABLE,
    };
    const { config, stored } = configFixture(original);
    const settings = loadNewsFeedSettings(config);
    expect(settings.needsMigration).toBe(false);
    expect(getEnabledNewsFeeds(settings)).toEqual([]);
    const writes = [
      () => saveNewsFeedSettings(config, { userFeeds: [], disabledDefaultFeedIds: [] }),
      () => addUserNewsFeed(config, { name: "Added", url: "https://example.test/added" }),
      () => updateUserNewsFeed(config, FEED.id, { enabled: false }),
      () => removeUserNewsFeed(config, FEED.id),
      () => setDefaultNewsFeedEnabled(config, DEFAULT_FEEDS[0]!.id, false),
      () => setDefaultNewsFeedEnabled(config, DEFAULT_FEEDS[0]!.id, true),
    ];
    for (const write of writes) {
      await expect(write()).rejects.toThrow(ERROR);
      expect(Object.fromEntries(stored)).toEqual(original);
    }
    expect(config.set).not.toHaveBeenCalled();

    // Repairing the stored value is enough; failure is not latched in memory.
    stored.set(key, key === "feeds" ? JSON.stringify([FEED]) : "[]");
    await updateUserNewsFeed(config, FEED.id, { enabled: false });
    expect(loadNewsFeedSettings(config).userFeeds[0]!.enabled).toBe(false);
    expect(loadNewsFeedSettings(config).error).toBeUndefined();
  });
}

test("a settings snapshot cannot overwrite corruption introduced after it was read", async () => {
  const { config, stored } = configFixture({ feeds: [FEED], disabledDefaultFeedIds: [] });
  const snapshot = loadNewsFeedSettings(config);
  stored.set("feeds", UNREADABLE);
  await expect(saveNewsFeedSettings(config, snapshot)).rejects.toThrow(ERROR);
  expect(stored.get("feeds")).toBe(UNREADABLE);
  expect(config.set).not.toHaveBeenCalled();
});

test("a second settings write rechecks readability after the first write yields", async () => {
  const { config, stored } = configFixture({ feeds: [FEED], disabledDefaultFeedIds: [] });
  config.set = mock(async (key: string, value: unknown) => {
    stored.set(key, value);
    if (key === "feeds") stored.set("disabledDefaultFeedIds", UNREADABLE);
  });
  await expect(saveNewsFeedSettings(config, { userFeeds: [FEED], disabledDefaultFeedIds: [] }))
    .rejects.toThrow(ERROR);
  expect(stored.get("disabledDefaultFeedIds")).toBe(UNREADABLE);
  expect(config.set).toHaveBeenCalledTimes(1);
});
