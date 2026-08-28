import type { NewsQuery } from "../../../../news/types";
import type { PaneProps } from "../../../../types/plugin";
import type { PluginModule } from "../../plugin-module";
import { BreakingPane } from "./breaking/pane";
import {
  BREAKING_NEWS_NOTIFICATIONS_ENABLED_KEY,
  setupBreakingNewsNotifications,
} from "./breaking/notifications";
import {
  addUserNewsFeed,
  getEnabledNewsFeeds,
  loadNewsFeedSettings,
  saveNewsFeedSettings,
} from "./feed-config";
import { IndustryPane } from "./industry-pane";
import { NewsPresetPane } from "./news/preset-pane";
import { NEWS_QUERY_PRESETS } from "./news/query-presets";
import type { NewsColumnId, NewsSortPreference } from "./news/table";
import { createRssNewsCapability } from "./rss/source";
import { openUrl } from "../../../../components/ui/external-link";
import {
  cachedNewsArticles,
  loadNewsArticles,
  searchNewsArticles,
} from "./article-search";

interface NewsPresetPaneConfig {
  paneKey: string;
  title: string;
  query: NewsQuery;
  columns: NewsColumnId[];
  defaultSort: NewsSortPreference;
  emptyStateTitle: string;
  emptyStateHint: string;
}

function createNewsPresetPane(config: NewsPresetPaneConfig) {
  return function PresetNewsPane(props: PaneProps) {
    return <NewsPresetPane {...props} {...config} />;
  };
}

const TopPane = createNewsPresetPane({
  paneKey: "top:curated",
  title: "Top News",
  query: NEWS_QUERY_PRESETS.top,
  columns: ["time", "source", "title", "tickers", "categories", "importance"],
  defaultSort: { columnId: "importance", direction: "desc" },
  emptyStateTitle: "No top stories yet",
  emptyStateHint: "Top stories appear when curated market sources publish them.",
});

const FeedPane = createNewsPresetPane({
  paneKey: "feed",
  title: "News Feed",
  query: NEWS_QUERY_PRESETS.feed,
  columns: ["time", "source", "title", "tickers", "categories", "sentiment"],
  defaultSort: { columnId: "time", direction: "desc" },
  emptyStateTitle: "No feed stories yet",
  emptyStateHint: "Run the Add News Feed command to wire up another source.",
});

let disposeBreakingNewsNotifications: (() => void) | null = null;

export const newsWireModule: PluginModule = {
  panes: [
    { id: "news-top", name: "Top News", icon: "T", component: TopPane, defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 90, height: 30 } },
    { id: "news-feed", name: "News Feed", icon: "N", component: FeedPane, defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 100, height: 35 } },
    { id: "news-industry", name: "Sector News", icon: "S", component: IndustryPane, defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 100, height: 35 } },
    {
      id: "news-breaking",
      name: "Breaking News",
      icon: "!",
      component: BreakingPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 85, height: 20 },
      settings: {
        title: "Breaking News Settings",
        fields: [{
          key: BREAKING_NEWS_NOTIFICATIONS_ENABLED_KEY,
          label: "Notifications",
          description: "Notify when new breaking stories arrive, even while this pane is closed.",
          type: "toggle",
          storage: "plugin",
        }],
      },
    },
  ],
  paneTemplates: [
    { id: "news-top-pane", paneId: "news-top", label: "Top News", description: "Curated top market stories ranked by importance", keywords: ["top", "news", "headlines", "stories"], shortcut: { prefix: "TOP" } },
    { id: "news-feed-pane", paneId: "news-feed", label: "News Feed", description: "Chronological market news firehose", keywords: ["news", "feed", "firehose", "wire", "stream"], shortcut: { prefix: "N" } },
    { id: "news-industry-pane", paneId: "news-industry", label: "Sector News", description: "Market news filtered by sector", keywords: ["news", "industry", "sector", "ni", "filter"], shortcut: { prefix: "NI" } },
    { id: "news-breaking-pane", paneId: "news-breaking", label: "Breaking News", description: "Breaking and urgent market news", keywords: ["first", "breaking", "urgent", "alert", "flash"], shortcut: { prefix: "FIRST" } },
  ],
  setup(ctx) {
    const initialSettings = loadNewsFeedSettings(ctx.configState);
    if (initialSettings.needsMigration) {
      void saveNewsFeedSettings(ctx.configState, initialSettings);
    }

    const source = createRssNewsCapability(
      () => getEnabledNewsFeeds(loadNewsFeedSettings(ctx.configState)),
      { persistence: ctx.persistence },
    );
    ctx.registerCapability(source);

    ctx.registerCommand({
      id: "open-news-article",
      label: "Open Article",
      description: "Search loaded news headlines by topic, e.g. ART hormuz.",
      keywords: ["article", "news", "rss", "headline", "story", "open"],
      category: "navigation",
      shortcut: "ART",
      shortcutArg: {
        placeholder: "headline or topic",
        kind: "text",
        parse: (arg) => ({ query: arg.trim() }),
      },
      async execute(values) {
        const query = values?.query ?? values?.shortcut ?? "";
        const articles = cachedNewsArticles().length > 0
          ? cachedNewsArticles()
          : await loadNewsArticles();
        const match = searchNewsArticles(articles, query)[0];
        if (!match) {
          ctx.notify({
            body: query.trim()
              ? `No article matched "${query.trim()}".`
              : "No articles loaded yet.",
            type: "error",
          });
          return;
        }
        openUrl(match.url);
      },
    });

    ctx.registerCommand({
      id: "add-news-feed",
      label: "Add News Feed",
      keywords: ["news", "rss", "feed", "add", "source"],
      category: "config",
      description: "Add a custom RSS news feed",
      wizardLayout: "form",
      wizard: [
        { key: "url", label: "Feed URL", type: "text", placeholder: "https://example.com/rss" },
        { key: "name", label: "Feed Name", type: "text", placeholder: "My Feed" },
        { key: "category", label: "Category", type: "select", options: [
          { label: "General", value: "general" },
          { label: "Tech", value: "tech" },
          { label: "Energy", value: "energy" },
          { label: "Finance", value: "finance" },
          { label: "Healthcare", value: "healthcare" },
          { label: "Macro", value: "macro" },
          { label: "Crypto", value: "crypto" },
        ]},
      ],
      async execute(values) {
        const url = values?.url?.trim();
        const name = values?.name?.trim();
        const category = values?.category ?? "general";
        if (!url || !name) return;

        const feed = await addUserNewsFeed(ctx.configState, { url, name, category });
        ctx.notify({ body: `Added news feed: ${feed.name}`, type: "success" });
      },
    });

    disposeBreakingNewsNotifications = setupBreakingNewsNotifications(ctx);
  },
  dispose() {
    disposeBreakingNewsNotifications?.();
    disposeBreakingNewsNotifications = null;
  },
};
