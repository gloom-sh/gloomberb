import type { PluginModule } from "../../plugin-module";
import {
  BREAKING_NEWS_NOTIFICATIONS_ENABLED_KEY,
  breakingNewsSnoozeCommand,
  setupBreakingNewsNotifications,
} from "./breaking/notifications";
import {
  BREAKING_MUTED_SECTOR_OPTIONS,
  BREAKING_NEWS_MUTED_SECTORS_KEY,
  BREAKING_NEWS_SCOPE_KEY,
  BREAKING_SCOPE_OPTIONS,
} from "./breaking/filters";
import {
  addUserNewsFeed,
  getEnabledNewsFeeds,
  loadNewsFeedSettings,
  saveNewsFeedSettings,
} from "./feed-config";
import { IndustryPane, TOPIC_NEWS_TITLE } from "./industry-pane";
import { newsMuteSettingsDef } from "./mutes";
import { createNewsPresetPane } from "./news/preset-pane";
import { createNewsStoryPaneTemplate, NEWS_STORY_PANE_ID, NewsStoryPane } from "./news/pop-out";
import { createLoadedStorySearchProvider } from "./news/command-bar-search";
import { NEWS_INDUSTRY_CODES, NEWS_QUERY_PRESETS, parseNewsIndustryCode } from "./news/query-presets";
import { createRssNewsCapability } from "./rss/source";
import { rssCliCommand } from "./rss/cli";
import { newsFeedHeadless } from "../headless";

const TopPane = createNewsPresetPane({
  paneKey: "top:curated",
  title: "Top News",
  query: NEWS_QUERY_PRESETS.top,
  // A story can merge several outlets, so one source name would misattribute it.
  // The rank orders the stories; the score behind it is not for reading.
  columns: ["rank", "time", "title", "tickers", "categories"],
  defaultSort: { columnId: "rank", direction: "desc" },
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

export const BreakingPane = createNewsPresetPane({
  paneKey: "breaking",
  title: "Breaking news",
  query: NEWS_QUERY_PRESETS.breaking,
  // A story can merge several outlets, so one source name would misattribute it.
  columns: ["time", "title", "tickers", "categories", "importance"],
  defaultSort: { columnId: "importance", direction: "desc" },
  emptyStateTitle: "No breaking news",
  emptyStateHint: "Breaking stories appear when high-priority headlines arrive.",
});

let disposeBreakingNewsNotifications: (() => void) | null = null;

const newsWirePanes: PluginModule["panes"] = [
    { id: "news-top", name: "Top News", icon: "T", component: TopPane, defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 90, height: 30 } },
    {
      id: "news-feed",
      name: "News Feed",
      icon: "N",
      component: FeedPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 100, height: 35 },
      settings: (context) => newsMuteSettingsDef(context, "News Feed Settings"),
    },
    {
      id: "news-industry",
      name: TOPIC_NEWS_TITLE,
      icon: "S",
      component: IndustryPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 100, height: 35 },
      settings: (context) => newsMuteSettingsDef(context, "Topic News Settings"),
    },
    {
      id: NEWS_STORY_PANE_ID,
      name: "Story",
      icon: "A",
      component: NewsStoryPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 80, height: 24 },
    },
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
        fields: [
          {
            key: BREAKING_NEWS_NOTIFICATIONS_ENABLED_KEY,
            label: "Notifications",
            description: "Notify when new breaking stories arrive, even while this pane is closed.",
            type: "toggle",
            storage: "plugin",
          },
          {
            key: BREAKING_NEWS_SCOPE_KEY,
            label: "Notify About",
            description: "Which breaking stories are worth interrupting you for.",
            type: "select",
            storage: "plugin",
            options: BREAKING_SCOPE_OPTIONS,
          },
          {
            key: BREAKING_NEWS_MUTED_SECTORS_KEY,
            label: "Muted Sectors",
            description: "Never notify about stories confined to these sectors.",
            type: "multi-select",
            storage: "plugin",
            options: BREAKING_MUTED_SECTOR_OPTIONS,
          },
        ],
      },
    },
];

const newsWirePaneTemplates: PluginModule["paneTemplates"] = [
  { id: "news-top-pane", paneId: "news-top", label: "Top News", description: "Curated top market stories ranked by importance", keywords: ["top", "news", "headlines", "stories"], shortcut: { prefix: "TOP" } },
  // FH is the same combined latest feed, Gloom Cloud with your RSS feeds, so it opens this pane.
  { id: "news-feed-pane", paneId: "news-feed", label: "News Feed", description: "Chronological market news firehose", keywords: ["news", "feed", "firehose", "wire", "stream", "latest"], shortcut: { prefix: "N", aliases: ["FH"] }, headless: newsFeedHeadless },
  {
    id: "news-industry-pane",
    paneId: "news-industry",
    label: TOPIC_NEWS_TITLE,
    description: "Market news by topic code (MNA, CB, ENERGY, REG, CRYPTO, EARN, IPO) or sector",
    keywords: ["news", "industry", "sector", "topic", "ni", "mna", "central banks", "crypto", "ipo", "earnings", "regulation"],
    shortcut: {
      prefix: "NI",
      argPlaceholder: "code",
      argKind: "text",
      argOptional: true,
      openWithoutArg: true,
      argOptions: () => NEWS_INDUSTRY_CODES
        .filter((entry) => entry.code !== "ALL")
        .map((entry) => ({ value: entry.code, label: entry.label })),
    },
    // An unknown code still opens, on a body that lists the codes.
    createInstance: (_context, options) => {
      const input = options?.arg?.trim();
      const code = input ? parseNewsIndustryCode(input)?.code ?? input.toUpperCase() : "ALL";
      return { title: code === "ALL" ? TOPIC_NEWS_TITLE : `NI ${code}`, params: { code } };
    },
  },
  { id: "news-breaking-pane", paneId: "news-breaking", label: "Breaking News", description: "Breaking and urgent market news", keywords: ["first", "breaking", "urgent", "alert", "flash"], shortcut: { prefix: "FIRST" } },
  createNewsStoryPaneTemplate(),
];

/**
 * The wire panes on Gloom Cloud news alone. The hosted browser cannot fetch
 * RSS feeds itself, so it gets the panes without the feed source and its
 * command; a shared wire pane still opens there on the same story.
 */
export const browserNewsWireModule: PluginModule = {
  panes: newsWirePanes,
  paneTemplates: newsWirePaneTemplates,
  setup(ctx) {
    ctx.registerCommand(breakingNewsSnoozeCommand(ctx));
    ctx.registerCommandBarSearchProvider(createLoadedStorySearchProvider(ctx));
    disposeBreakingNewsNotifications = setupBreakingNewsNotifications(ctx);
  },
  dispose() {
    disposeBreakingNewsNotifications?.();
    disposeBreakingNewsNotifications = null;
  },
};

export const newsWireModule: PluginModule = {
  panes: newsWirePanes,
  paneTemplates: newsWirePaneTemplates,
  cliCommands: [rssCliCommand],
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

    ctx.registerCommand(breakingNewsSnoozeCommand(ctx));
    ctx.registerCommandBarSearchProvider(createLoadedStorySearchProvider(ctx));
    disposeBreakingNewsNotifications = setupBreakingNewsNotifications(ctx);
  },
  dispose() {
    disposeBreakingNewsNotifications?.();
    disposeBreakingNewsNotifications = null;
  },
};
