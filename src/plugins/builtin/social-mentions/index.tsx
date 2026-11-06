import type { PluginModule } from "../plugin-module";
import { SOCIAL_MENTION_SERIES } from "./series";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { socialMentionPostsCache, socialMentionsCache } from "./client";
import { socialMentionsHeadless } from "./headless";
import { socialMentionsLockNote } from "./lock-note";
import { socialOutliersCache } from "./outliers-client";
import { SOCIAL_OUTLIERS_TITLE } from "./outliers-model";

const socialMentionsSettings = [
  { key: "socialRange", label: "History", type: "select" as const,
    options: [{ value: "1y", label: "1 year" }, { value: "5y", label: "5 years" }, { value: "max", label: "Since 2012" }] },
];
export const socialMentionsModule: PluginModule = {
  series: SOCIAL_MENTION_SERIES,
  panes: [{ id: "social-mentions", reportLockNote: socialMentionsLockNote, name: "Social Mentions", icon: "B", get component(): typeof import("./pane").SocialMentionsPane { const { SocialMentionsPane } = require("./pane"); return SocialMentionsPane; },
    defaultPosition: "right", tickerFollower: true, defaultMode: "floating", defaultFloatingSize: { width: 96, height: 30 },
    tableExport: true, headless: socialMentionsHeadless, settings: { title: "Social Mentions", fields: socialMentionsSettings } }],
  paneTemplates: [{ ...createTickerSurfacePaneTemplate({ id: "social-mentions-pane", paneId: "social-mentions", label: "Social Mentions",
    description: "Daily posts on X naming the ticker's cashtag, the day's top posts and their stance; alone, the tickers whose posts jump most against their own median.",
    shortcut: "BUZZ", keywords: ["social", "mentions", "x", "twitter", "buzz", "sentiment", "stance", "cashtag", "outliers"], publicShare: true,
    // Typed alone with no active ticker it ranks the market's social outliers.
    withoutTickerTitle: SOCIAL_OUTLIERS_TITLE,
  }), headless: socialMentionsHeadless }],
  setup(ctx) { socialMentionsCache.attach(ctx.persistence); socialMentionPostsCache.attach(ctx.persistence); socialOutliersCache.attach(ctx.persistence); },
  dispose() { socialMentionsCache.reset(); socialMentionPostsCache.reset(); socialOutliersCache.reset(); },
};
