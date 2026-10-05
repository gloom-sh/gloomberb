import { useMemo } from "react";
import type { NewsFeed, NewsQuery } from "../../../../news/types";
import { getSharedNewsService } from "../../../../news/hooks";
import { usePluginConfigState } from "../../../runtime";
import type {
  PaneSettingField,
  PaneSettingOption,
  PaneSettingsContext,
  PaneSettingsDef,
} from "../../../../types/plugin";
import { NEWS_QUERY_PRESETS, parseNewsIndustryCode } from "./news/query-presets";

/** Plugin id that owns the news settings in `config.pluginConfig`. */
const NEWS_PLUGIN_ID = "news";

/** Saved as `pluginConfig.news.newsMutedSources`: the picker writes string[]. */
export const NEWS_MUTED_SOURCES_KEY = "newsMutedSources";
/** Saved as `pluginConfig.news.newsMutedKeywords`: the text field edits a comma-separated string. */
export const NEWS_MUTED_KEYWORDS_KEY = "newsMutedKeywords";

/** Guard against a runaway saved value flooding every filter pass. */
export const MAX_MUTED_KEYWORDS = 200;

export interface NewsMutes {
  sources: string[];
  keywords: string[];
}

function pushUnique(seen: Set<string>, values: string[], entry: string): void {
  const key = entry.toLowerCase();
  if (!key || seen.has(key)) return;
  seen.add(key);
  values.push(entry);
}

/** Muted publishers saved by the Muted Sources picker. */
export function parseNewsMutedSources(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const sources: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    pushUnique(seen, sources, entry.trim());
  }
  return sources;
}

function rawKeywordEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  return [];
}

/**
 * Muted keywords saved by the Muted Keywords text field. Accepts the raw
 * comma-separated string the field edits, plus a string[] for programmatic
 * writes; entries may themselves contain separators.
 */
export function parseNewsMutedKeywords(value: unknown): string[] {
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const raw of rawKeywordEntries(value)) {
    if (typeof raw !== "string") continue;
    for (const token of raw.split(/[,;\n]/)) {
      pushUnique(seen, keywords, token.trim());
      if (keywords.length >= MAX_MUTED_KEYWORDS) return keywords;
    }
  }
  return keywords;
}

export function readNewsMutesFromPluginConfig(
  pluginConfig: Record<string, unknown> | undefined,
): NewsMutes {
  return {
    sources: parseNewsMutedSources(pluginConfig?.[NEWS_MUTED_SOURCES_KEY]),
    keywords: parseNewsMutedKeywords(pluginConfig?.[NEWS_MUTED_KEYWORDS_KEY]),
  };
}

/** Feed lists only. Top News and Breaking News keep every story. */
export function newsMutesApplyToFeed(feed: NewsFeed | undefined): boolean {
  return feed === "latest" || feed === "ticker" || feed === "sector" || feed === "topic";
}

function normalizedMuteTerms(values: readonly string[]): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = value.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    terms.push(key);
  }
  return terms;
}

function articleMatchesMute(
  article: { source?: string; title?: string },
  sources: ReadonlySet<string>,
  keywords: readonly string[],
): boolean {
  const source = (article.source ?? "").trim().toLowerCase();
  if (source && sources.has(source)) return true;
  const title = (article.title ?? "").trim().toLowerCase();
  if (!title) return false;
  return keywords.some((keyword) => title.includes(keyword));
}

/** Drops stories whose publisher or headline matches a mute. Empty lists mute nothing. */
export function applyNewsMutes<T extends { source?: string; title?: string }>(
  articles: readonly T[],
  mutes: { sources: readonly string[]; keywords: readonly string[] } | null | undefined,
): T[] {
  if (!mutes) return articles as T[];
  const sources = normalizedMuteTerms(mutes.sources);
  const keywords = normalizedMuteTerms(mutes.keywords);
  if (sources.length === 0 && keywords.length === 0) return articles as T[];
  const sourceSet = new Set(sources);
  return articles.filter((article) => !articleMatchesMute(article, sourceSet, keywords));
}

export function useNewsMuteFilter<T extends { source?: string; title?: string }>(
  articles: readonly T[],
  enabled: boolean,
): T[] {
  const [sourcesValue] = usePluginConfigState<unknown>(NEWS_MUTED_SOURCES_KEY, null);
  const [keywordsValue] = usePluginConfigState<unknown>(NEWS_MUTED_KEYWORDS_KEY, null);
  return useMemo(() => {
    if (!enabled) return articles as T[];
    return applyNewsMutes(articles, {
      sources: parseNewsMutedSources(sourcesValue),
      keywords: parseNewsMutedKeywords(keywordsValue),
    });
  }, [articles, enabled, keywordsValue, sourcesValue]);
}

/** Cap keeps the picker usable when hundreds of feeds have loaded. */
const MAX_SOURCE_OPTIONS = 200;

/**
 * Publisher vocabulary for the Muted Sources picker: distinct `source` values
 * from recently loaded articles, plus already-muted names so a source with no
 * recent stories can still be un-muted.
 */
export function collectNewsSourceOptions(
  articles: readonly { source?: string }[],
  extraSources: readonly string[] = [],
): PaneSettingOption[] {
  const seen = new Set<string>();
  const extraKeys = new Set<string>();
  const names: string[] = [];
  for (const source of extraSources) {
    const trimmed = source.trim();
    const key = trimmed.toLowerCase();
    if (!key) continue;
    extraKeys.add(key);
    pushUnique(seen, names, trimmed);
  }
  for (const article of articles) {
    pushUnique(seen, names, (article.source ?? "").trim());
  }
  const sorted = names.sort((left, right) => left.localeCompare(right));
  const retainedExtraKeys = new Set([...extraKeys].slice(0, MAX_SOURCE_OPTIONS));
  // Keep currently-muted sources selectable before filling the rest of the
  // picker, so a muted name is not stranded behind the article cap.
  let visible = sorted;
  if (sorted.length > MAX_SOURCE_OPTIONS) {
    const mutedNames = sorted.filter((name) => retainedExtraKeys.has(name.toLowerCase()));
    const others = sorted
      .filter((name) => !retainedExtraKeys.has(name.toLowerCase()))
      .slice(0, Math.max(0, MAX_SOURCE_OPTIONS - retainedExtraKeys.size));
    visible = [...mutedNames, ...others].sort((left, right) => left.localeCompare(right));
  }
  return visible.map((name) => ({ value: name, label: name }));
}

function pluginNewsState(paneState: Record<string, unknown>): Record<string, unknown> {
  const pluginState = paneState.pluginState;
  if (!pluginState || typeof pluginState !== "object") return {};
  const news = (pluginState as Record<string, unknown>)[NEWS_PLUGIN_ID];
  if (!news || typeof news !== "object") return {};
  return news as Record<string, unknown>;
}

function articlesInPaneState(paneState: Record<string, unknown>): { source?: string }[] {
  const articles: { source?: string }[] = [];
  for (const value of Object.values(pluginNewsState(paneState))) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const source = (entry as { source?: unknown }).source;
      if (typeof source === "string") articles.push({ source });
    }
  }
  return articles;
}

function muteSourceQuery(context: PaneSettingsContext): NewsQuery | null {
  if (context.paneType === "news-feed") return NEWS_QUERY_PRESETS.feed;
  if (context.paneType === "ticker-news") {
    if (!context.activeTicker) return null;
    return NEWS_QUERY_PRESETS.ticker(context.activeTicker);
  }
  if (context.paneType !== "news-industry") return null;
  const saved = pluginNewsState(context.paneState)["industry:category"];
  const fromParams = context.pane.params?.code;
  const code = typeof saved === "string" ? saved : fromParams;
  const entry = parseNewsIndustryCode(typeof code === "string" ? code : "");
  if (!entry) return null;
  if (entry.topic) return NEWS_QUERY_PRESETS.topic(entry.topic);
  return NEWS_QUERY_PRESETS.sectorAll;
}

function articlesForMuteSettings(context: PaneSettingsContext): { source?: string }[] {
  const fromPane = articlesInPaneState(context.paneState);
  const service = getSharedNewsService();
  const query = muteSourceQuery(context);
  if (!service || !query) return fromPane;
  return [...fromPane, ...service.getQueryState(query).articles];
}

function newsMuteSettingFields(
  articles: readonly { source?: string }[],
  mutedSources: readonly string[],
): PaneSettingField[] {
  return [
    {
      key: NEWS_MUTED_SOURCES_KEY,
      label: "Muted Sources",
      description: "Hide these publishers' stories in News Feed, Topic News and Ticker News. Top News and Breaking News still show them.",
      type: "multi-select",
      storage: "plugin",
      options: collectNewsSourceOptions(articles, mutedSources),
    },
    {
      key: NEWS_MUTED_KEYWORDS_KEY,
      label: "Muted Keywords",
      description: "Hide stories whose headline contains any of these, separated by commas, in News Feed, Topic News and Ticker News.",
      type: "text",
      storage: "plugin",
      placeholder: "crypto, earnings call",
    },
  ];
}

export function newsMuteSettingsDef(context: PaneSettingsContext, title: string): PaneSettingsDef {
  const mutes = readNewsMutesFromPluginConfig(context.config.pluginConfig[NEWS_PLUGIN_ID]);
  return {
    title,
    fields: newsMuteSettingFields(articlesForMuteSettings(context), mutes.sources),
  };
}
