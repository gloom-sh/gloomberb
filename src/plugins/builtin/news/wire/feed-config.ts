import type { PluginConfigState } from "../../../../types/plugin";
import { DEFAULT_FEEDS } from "./default-feeds";
import { hashString } from "./hash";
import type { RssFeedConfig } from "./rss/parser";

const USER_FEEDS_KEY = "feeds";
const DISABLED_DEFAULT_FEED_IDS_KEY = "disabledDefaultFeedIds";
const LEGACY_DISABLED_DEFAULT_FEEDS_KEY = "disabledDefaultFeeds";

const DEFAULT_FEED_IDS = new Set(DEFAULT_FEEDS.map((feed) => feed.id));

export interface NewsFeedSettings {
  userFeeds: RssFeedConfig[];
  disabledDefaultFeedIds: string[];
  needsMigration: boolean;
}

export interface UserNewsFeedInput {
  id?: string;
  url: string;
  name: string;
  category?: string;
  authority?: number;
  enabled?: boolean;
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}

function normalizeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCategory(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  return trimmed || undefined;
}

function normalizeAuthority(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function createUserFeedId(url: string, name: string): string {
  return `user-${hashString(`${url}|${name}`)}`;
}

export function createUserFeed(input: UserNewsFeedInput): RssFeedConfig {
  const url = normalizeUrl(input.url);
  const name = normalizeName(input.name);
  if (!url) throw new Error("Feed URL must be an http(s) URL.");
  if (!name) throw new Error("Feed name is required.");

  return {
    id: input.id?.trim() || createUserFeedId(url, name),
    url,
    name,
    category: normalizeCategory(input.category) ?? "general",
    authority: normalizeAuthority(input.authority, 50),
    enabled: input.enabled !== false,
  };
}

function normalizeUserFeed(value: unknown): RssFeedConfig | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  try {
    return createUserFeed({
      id: typeof record.id === "string" ? record.id : undefined,
      url: String(record.url ?? ""),
      name: String(record.name ?? ""),
      category: typeof record.category === "string" ? record.category : undefined,
      authority: typeof record.authority === "number" ? record.authority : undefined,
      enabled: record.enabled !== false,
    });
  } catch {
    return null;
  }
}

function normalizeDisabledDefaultFeedIds(values: unknown[]): string[] {
  const legacyNameToId = new Map(DEFAULT_FEEDS.map((feed) => [feed.name, feed.id]));
  const ids = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    const id = DEFAULT_FEED_IDS.has(trimmed) ? trimmed : legacyNameToId.get(trimmed);
    if (id) ids.add(id);
  }
  return [...ids];
}

function sameUserFeeds(raw: unknown, normalized: RssFeedConfig[]): boolean {
  if (!Array.isArray(raw) || raw.length !== normalized.length) return false;
  return raw.every((entry, index) => {
    const feed = normalized[index];
    if (!feed || !entry || typeof entry !== "object") return false;
    const record = entry as Record<string, unknown>;
    return record.id === feed.id
      && record.url === feed.url
      && record.name === feed.name
      && record.category === feed.category
      && record.authority === feed.authority
      && record.enabled === feed.enabled;
  });
}

function sameIdList(raw: unknown, normalized: string[]): boolean {
  if (!Array.isArray(raw) || raw.length !== normalized.length) return false;
  return raw.every((value, index) => value === normalized[index]);
}

export function loadNewsFeedSettings(configState: PluginConfigState): NewsFeedSettings {
  const rawUserFeeds = configState.get<unknown>(USER_FEEDS_KEY);
  const userFeedValues = parseJsonArray(rawUserFeeds);
  const userFeeds = userFeedValues
    .map(normalizeUserFeed)
    .filter((feed): feed is RssFeedConfig => !!feed);

  const rawDisabledIds = configState.get<unknown>(DISABLED_DEFAULT_FEED_IDS_KEY);
  const rawLegacyDisabled = configState.get<unknown>(LEGACY_DISABLED_DEFAULT_FEEDS_KEY);
  const disabledDefaultFeedIds = normalizeDisabledDefaultFeedIds([
    ...parseJsonArray(rawDisabledIds),
    ...parseJsonArray(rawLegacyDisabled),
  ]);

  const needsMigration = rawLegacyDisabled !== null
    || (rawUserFeeds !== null && !sameUserFeeds(rawUserFeeds, userFeeds))
    || (rawDisabledIds !== null && !sameIdList(rawDisabledIds, disabledDefaultFeedIds));

  return { userFeeds, disabledDefaultFeedIds, needsMigration };
}

export async function saveNewsFeedSettings(
  configState: PluginConfigState,
  settings: Pick<NewsFeedSettings, "userFeeds" | "disabledDefaultFeedIds">,
): Promise<void> {
  await configState.set(USER_FEEDS_KEY, settings.userFeeds);
  await configState.set(DISABLED_DEFAULT_FEED_IDS_KEY, settings.disabledDefaultFeedIds);
  await configState.delete(LEGACY_DISABLED_DEFAULT_FEEDS_KEY);
}

export function getEnabledNewsFeeds(settings: Pick<NewsFeedSettings, "userFeeds" | "disabledDefaultFeedIds">): RssFeedConfig[] {
  const disabled = new Set(settings.disabledDefaultFeedIds);
  return [
    ...DEFAULT_FEEDS.filter((feed) => feed.enabled && !disabled.has(feed.id)),
    ...settings.userFeeds.filter((feed) => feed.enabled),
  ];
}

export async function addUserNewsFeed(
  configState: PluginConfigState,
  input: UserNewsFeedInput,
): Promise<RssFeedConfig> {
  const settings = loadNewsFeedSettings(configState);
  const feed = createUserFeed(input);
  const nextUserFeeds = [
    ...settings.userFeeds.filter((entry) => entry.id !== feed.id),
    feed,
  ];
  await saveNewsFeedSettings(configState, {
    userFeeds: nextUserFeeds,
    disabledDefaultFeedIds: settings.disabledDefaultFeedIds,
  });
  return feed;
}

export async function updateUserNewsFeed(
  configState: PluginConfigState,
  feedId: string,
  patch: Partial<UserNewsFeedInput>,
): Promise<RssFeedConfig | null> {
  const settings = loadNewsFeedSettings(configState);
  const existing = settings.userFeeds.find((feed) => feed.id === feedId);
  if (!existing) return null;
  const nextFeed = createUserFeed({
    ...existing,
    ...patch,
    id: feedId,
  });
  await saveNewsFeedSettings(configState, {
    userFeeds: settings.userFeeds.map((feed) => feed.id === feedId ? nextFeed : feed),
    disabledDefaultFeedIds: settings.disabledDefaultFeedIds,
  });
  return nextFeed;
}

export async function removeUserNewsFeed(
  configState: PluginConfigState,
  feedId: string,
): Promise<boolean> {
  const settings = loadNewsFeedSettings(configState);
  const nextUserFeeds = settings.userFeeds.filter((feed) => feed.id !== feedId);
  if (nextUserFeeds.length === settings.userFeeds.length) return false;
  await saveNewsFeedSettings(configState, {
    userFeeds: nextUserFeeds,
    disabledDefaultFeedIds: settings.disabledDefaultFeedIds,
  });
  return true;
}

export async function setDefaultNewsFeedEnabled(
  configState: PluginConfigState,
  feedId: string,
  enabled: boolean,
): Promise<boolean> {
  if (!DEFAULT_FEED_IDS.has(feedId)) return false;
  const settings = loadNewsFeedSettings(configState);
  const disabled = new Set(settings.disabledDefaultFeedIds);
  if (enabled) disabled.delete(feedId);
  else disabled.add(feedId);
  await saveNewsFeedSettings(configState, {
    userFeeds: settings.userFeeds,
    disabledDefaultFeedIds: [...disabled],
  });
  return true;
}
