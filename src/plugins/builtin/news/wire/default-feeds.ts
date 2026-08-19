import type { RssFeedConfig } from "./rss/parser";

/**
 * Bundled so a terminal without a Gloom Cloud session still has a wire to read.
 * All of these are public, key-free RSS endpoints; users can disable any of
 * them and add their own with the Add News Feed command.
 */
export const DEFAULT_FEEDS: RssFeedConfig[] = [
  {
    id: "default-cnbc-top",
    url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114",
    name: "CNBC",
    category: "general",
    authority: 70,
    enabled: true,
  },
  {
    id: "default-marketwatch-top",
    url: "https://feeds.content.dowjones.io/public/rss/mw_topstories",
    name: "MarketWatch",
    category: "general",
    authority: 70,
    enabled: true,
  },
  {
    id: "default-yahoo-finance",
    url: "https://finance.yahoo.com/news/rssindex",
    name: "Yahoo Finance",
    category: "general",
    authority: 60,
    enabled: true,
  },
  {
    id: "default-bbc-business",
    url: "https://feeds.bbci.co.uk/news/business/rss.xml",
    name: "BBC Business",
    category: "general",
    authority: 65,
    enabled: true,
  },
  {
    id: "default-fed-press",
    url: "https://www.federalreserve.gov/feeds/press_all.xml",
    name: "Federal Reserve",
    category: "macro",
    authority: 90,
    enabled: true,
  },
];
