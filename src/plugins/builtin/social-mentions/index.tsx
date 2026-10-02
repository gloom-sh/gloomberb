import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { socialMentionPostsCache, socialMentionsCache } from "./client";
import { socialMentionsHeadless } from "./headless";
import { SocialMentionsPane } from "./pane";

const socialMentionsSettings = [
  { key: "socialRange", label: "History", type: "select" as const,
    options: [{ value: "1y", label: "1 year" }, { value: "5y", label: "5 years" }, { value: "max", label: "Since 2012" }] },
];
export const socialMentionsModule: PluginModule = {
  panes: [{ id: "social-mentions", name: "Social Mentions", icon: "B", component: SocialMentionsPane,
    defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 96, height: 30 },
    tableExport: true, headless: socialMentionsHeadless, settings: { title: "Social Mentions", fields: socialMentionsSettings } }],
  paneTemplates: [{ ...createTickerSurfacePaneTemplate({ id: "social-mentions-pane", paneId: "social-mentions", label: "Social Mentions",
    description: "Daily posts on X naming the ticker's cashtag, the day's top posts and their stance.",
    shortcut: "BUZZ", keywords: ["social", "mentions", "x", "twitter", "buzz", "sentiment", "stance", "cashtag"], publicShare: true,
  }), headless: socialMentionsHeadless }],
  setup(ctx) { socialMentionsCache.attach(ctx.persistence); socialMentionPostsCache.attach(ctx.persistence); },
  dispose() { socialMentionsCache.reset(); socialMentionPostsCache.reset(); },
};
