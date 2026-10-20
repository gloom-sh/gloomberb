import type { RssFeedConfig } from "./parser";

export const MANAGED_NEWS_FEED: RssFeedConfig = {
  id: "default-gloom-news",
  url: "https://api.gloom.sh/news/rss",
  name: "Gloom Cloud News",
  category: "general",
  authority: 60,
  enabled: true,
};

export function isManagedNewsFeedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === "https://api.gloom.sh" && url.pathname.replace(/\/$/, "") === "/news/rss";
  } catch {
    // Intentional ignore: malformed URLs cannot identify the managed news feed.
    return false;
  }
}
