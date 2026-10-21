import { describe, expect, test } from "bun:test";
import type { CloudNewsPayload } from "../../../api-client";
import { NewsService } from "../../../news/aggregator";
import { createDesktopNewsSource } from "./news-source";

const STORY_ID = "bd033205-3db2-443f-a85d-3c6521710259";

function cloudStory(id: string): CloudNewsPayload {
  return {
    id,
    headline: "Apple raises guidance",
    summary: "Apple lifted its outlook.",
    category: "guidance",
    sentiment: "positive",
    sectors: [],
    firstPublishedAt: "2026-04-01T10:00:00.000Z",
    lastPublishedAt: "2026-04-01T10:05:00.000Z",
    firstSeenAt: "2026-04-01T10:00:10.000Z",
    lastSeenAt: "2026-04-01T10:05:10.000Z",
    primaryUrl: "https://example.com/aapl-guidance",
    primarySource: "example-wire",
    variantCount: 1,
    sourceCount: 1,
    sources: ["example-wire"],
    entities: [],
    tickerLinks: [],
  };
}

function desktopNews(getCloudNewsStory: (id: string) => Promise<CloudNewsPayload>) {
  // The view's service has no Cloud capability; this source is all it has.
  const service = new NewsService({ pollIntervalMs: 60_000 });
  service.register(createDesktopNewsSource(
    { id: "desktop-backend", name: "Gloomberb Backend", getNews: async () => [], getNewsPage: async () => ({ articles: [] }) },
    { getCloudNews: async () => ({ items: [], nextCursor: null }), getCloudNewsStory },
  ));
  return service;
}

describe("desktop news source", () => {
  test("opens a story by id with no list copy, as a chat link does", async () => {
    const requested: string[] = [];
    const service = desktopNews(async (id) => {
      requested.push(id);
      return cloudStory(id);
    });

    const story = await service.loadStory(STORY_ID);

    expect(requested).toEqual([STORY_ID]);
    expect(story?.id).toBe(STORY_ID);
    expect(story?.title).toBe("Apple raises guidance");
  });

  test("a story Cloud does not have rejects instead of answering another story", async () => {
    const service = desktopNews(async () => { throw new Error("404 Not Found"); });

    await expect(service.loadStory(STORY_ID)).rejects.toThrow("Story detail unavailable.");
  });
});
