import type { GloomPluginContext } from "../../../types/plugin";
import { canonicalExchange } from "../../../utils/exchanges";
import {
  TWITTER_FEED_LAUNCH_SCHEMA_VERSION,
  TWITTER_FEED_LAUNCH_STATE_KEY,
  TWITTER_FEED_PANE_ID,
  normalizeFeeds,
  type TwitterFeedLaunchRequest,
} from "./model";
import {
  TwitterFeedPane,
  TwitterTickerTab,
} from "./pane";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function registerTwitterFeedFeature(ctx: GloomPluginContext): void {
  ctx.registerTickerResearchTab({
    id: "ticker-tweets",
    name: "Tweets",
    order: 38,
    component: TwitterTickerTab,
    isVisible: ({ ticker }) => {
      if (!ticker) return false;
      const exchange = canonicalExchange(ticker.metadata.exchange);
      return !exchange || ["NASDAQ", "NYSE", "AMEX", "ARCA", "BATS", "OTC", "PINK"].includes(exchange);
    },
  });

  ctx.registerPane({
    id: TWITTER_FEED_PANE_ID,
    name: "X Feed",
    icon: "X",
    component: TwitterFeedPane,
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 94, height: 28 },
  });

  ctx.registerPaneTemplate({
    id: "twitter-feed-pane",
    paneId: TWITTER_FEED_PANE_ID,
    label: "X Feed",
    description: "Open an X advanced-search feed.",
    keywords: ["twitter", "x", "tweet", "tweets", "feed", "social"],
    createInstance: (_context, options) => {
      const shared = record(options?.shareData) ? options.shareData : null;
      const query = typeof shared?.query === "string"
        ? shared.query.trim()
        : options?.values?.query?.trim() || options?.arg?.trim() || "";
      const queryType = shared?.queryType === "Top" || options?.values?.queryType === "Top"
        ? "Top"
        : "Latest";
      return {
        title: "X Feed",
        placement: "floating",
        params: { query, queryType },
      };
    },
    publicShare: {
      serialize: ({ pane, paneState }) => {
        const pluginState = record(paneState.pluginState)
          ? paneState.pluginState["gloomberb-cloud"]
          : null;
        const feedsState = record(pluginState) ? pluginState.feeds : null;
        const feeds = normalizeFeeds(feedsState);
        const activeFeedId = record(pluginState) && typeof pluginState.activeFeedId === "string"
          ? pluginState.activeFeedId
          : null;
        const active = feeds.find((feed) => feed.id === activeFeedId) ?? feeds[0];
        const query = active?.query.trim()
          || (typeof pane.params?.query === "string" ? pane.params.query.trim() : "");
        if (!query) return null;
        return {
          title: pane.title?.trim() || "X Feed",
          data: {
            query,
            queryType: active?.queryType === "Top" || pane.params?.queryType === "Top" ? "Top" : "Latest",
          },
        };
      },
      restore: (data) => (
        Object.keys(data).every((key) => key === "query" || key === "queryType")
        && typeof data.query === "string"
        && data.query.trim().length > 0
        && (data.queryType === "Latest" || data.queryType === "Top")
          ? { shareData: { query: data.query.trim(), queryType: data.queryType } }
          : null
      ),
    },
  });

  ctx.registerCommand({
    id: "twitter-feed-open",
    label: "X Feed",
    description: "Open an X advanced-search feed.",
    keywords: ["twitter", "x", "tweet", "tweets", "feed", "social", "twit"],
    category: "navigation",
    shortcut: "TWIT",
    shortcutArg: {
      placeholder: "query",
      kind: "text",
      parse: (arg) => ({ query: arg.trim() }),
    },
    execute: (values) => {
      openTwitterFeed(ctx, values?.query ?? values?.shortcut ?? "");
    },
  });
}

function openTwitterFeed(ctx: GloomPluginContext, query = "") {
  const targetPaneId = ctx.getConfig().layout.instances.find((instance) => (
    instance.paneId === TWITTER_FEED_PANE_ID
  ))?.instanceId ?? null;
  const now = Date.now();
  const launchRequest: TwitterFeedLaunchRequest = {
    query: query.trim(),
    targetPaneId,
    nonce: `${now}-${Math.random().toString(36).slice(2)}`,
    createdAt: now,
  };

  ctx.resume.setState(
    TWITTER_FEED_LAUNCH_STATE_KEY,
    launchRequest,
    { schemaVersion: TWITTER_FEED_LAUNCH_SCHEMA_VERSION },
  );
  ctx.focusPane(TWITTER_FEED_PANE_ID);
}
