import { describe, expect, test } from "bun:test";
import type { PluginConfigState } from "../../../../types/plugin";
import {
  addUserNewsFeed,
  createUserFeed,
  getEnabledNewsFeeds,
  loadNewsFeedSettings,
  removeUserNewsFeed,
  setDefaultNewsFeedEnabled,
  updateUserNewsFeed,
} from "./feed-config";

class MemoryConfigState implements PluginConfigState {
  values = new Map<string, unknown>();

  get<T = unknown>(key: string): T | null {
    return (this.values.get(key) as T | undefined) ?? null;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  keys(): string[] {
    return [...this.values.keys()];
  }
}

describe("news feed config", () => {
  test("normalizes legacy JSON feed storage and migrates disabled default feed names to ids", () => {
    const config = new MemoryConfigState();
    config.values.set("feeds", JSON.stringify([
      { url: "https://example.com/rss.xml", name: "Example", authority: 120 },
      { url: "ftp://example.com/invalid.xml", name: "Invalid" },
    ]));
    config.values.set("disabledDefaultFeeds", JSON.stringify(["CNBC", "missing"]));

    const settings = loadNewsFeedSettings(config);

    expect(settings.userFeeds).toHaveLength(1);
    expect(settings.userFeeds[0]!.id).toMatch(/^user-/);
    expect(settings.userFeeds[0]!.authority).toBe(100);
    expect(settings.disabledDefaultFeedIds).toEqual(["default-cnbc-top"]);
  });

  test("adds, updates, and removes user feeds through typed helpers", async () => {
    const config = new MemoryConfigState();

    const added = await addUserNewsFeed(config, {
      url: "https://example.com/feed",
      name: "Example",
      category: "Tech",
    });
    expect(added.category).toBe("tech");

    const updated = await updateUserNewsFeed(config, added.id, {
      name: "Example Markets",
      authority: 75,
    });
    expect(updated?.name).toBe("Example Markets");
    expect(updated?.authority).toBe(75);

    const removed = await removeUserNewsFeed(config, added.id);
    expect(removed).toBe(true);
    expect(loadNewsFeedSettings(config).userFeeds).toHaveLength(0);
  });

  test("serves bundled default feeds alongside user feeds and honours disabled defaults", async () => {
    const config = new MemoryConfigState();

    const bundledIds = getEnabledNewsFeeds(loadNewsFeedSettings(config)).map((feed) => feed.id);
    expect(bundledIds).toContain("default-cnbc-top");

    const added = await addUserNewsFeed(config, {
      url: "https://example.com/feed",
      name: "Example",
    });
    expect(getEnabledNewsFeeds(loadNewsFeedSettings(config)).map((feed) => feed.id))
      .toEqual([...bundledIds, added.id]);

    expect(await setDefaultNewsFeedEnabled(config, "default-cnbc-top", false)).toBe(true);
    expect(getEnabledNewsFeeds(loadNewsFeedSettings(config)).map((feed) => feed.id))
      .not.toContain("default-cnbc-top");
    expect(await setDefaultNewsFeedEnabled(config, "missing-default-feed", false)).toBe(false);
  });

  test("rejects invalid user feed input", () => {
    expect(() => createUserFeed({ url: "not-url", name: "Bad" })).toThrow("Feed URL");
    expect(() => createUserFeed({ url: "https://example.com/feed", name: "" })).toThrow("Feed name");
  });
});
