import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { SocialMentionDayPosts, SocialMentionPost, SocialMentionsPayload, SocialMentionsRange } from "../../../api-client/social-mentions";
import { createPluginCache } from "../../../data/plugin-cache";

export const socialMentionsCache = createPluginCache<SocialMentionsPayload>({
  kind: "social-mentions", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 15 * 60_000, expireMs: 7 * 24 * 60 * 60_000 },
});
// A closed day's top posts only change by a few views; keep them a week.
export const socialMentionPostsCache = createPluginCache<SocialMentionDayPosts>({
  kind: "social-mention-posts", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 24 * 60 * 60_000, expireMs: 7 * 24 * 60 * 60_000 },
});

const day = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const count = (value: unknown) => value === null || Number.isInteger(value) && (value as number) >= 0;
const stance = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= -1 && value <= 1;
function validPost(post: SocialMentionPost): boolean {
  return !!post && /^\d{1,24}$/.test(post.id) && day(post.day) && typeof post.author === "string" && typeof post.text === "string"
    && Number.isFinite(Date.parse(post.postedAt)) && [post.views, post.likes, post.reposts, post.replies].every(count)
    && typeof post.url === "string" && post.url.startsWith("https://x.com/") && (post.stance === null || stance(post.stance));
}

function validWikipedia(wiki: NonNullable<SocialMentionsPayload["wikipedia"]>): boolean {
  return !!wiki && (wiki.article === null || typeof wiki.article === "string") && Array.isArray(wiki.days)
    && wiki.days.every((row, i) => day(row.day) && Number.isInteger(row.views) && row.views >= 0 && (i === 0 || row.day > wiki.days[i - 1]!.day))
    && (wiki.baseline === null || typeof wiki.baseline === "number" && wiki.baseline >= 0);
}

function validReddit(reddit: NonNullable<SocialMentionsPayload["reddit"]>): boolean {
  return !!reddit && Array.isArray(reddit.days)
    && reddit.days.every((row, i) => day(row.day) && Number.isInteger(row.mentions) && row.mentions >= 0 && (i === 0 || row.day > reddit.days[i - 1]!.day))
    && (reddit.baseline === null || typeof reddit.baseline === "number" && reddit.baseline >= 0);
}

/** Days ascending and unique, counts whole, stances in range, posts linking to X only. */
export function validateSocialMentions(payload: SocialMentionsPayload, symbol: string, range: SocialMentionsRange): SocialMentionsPayload {
  const days = payload?.x?.days;
  if (!payload || payload.symbol !== symbol || payload.range !== range || !Array.isArray(days)
    || days.some((row, i) => !day(row.day) || !Number.isInteger(row.mentions) || row.mentions < 0 || typeof row.closed !== "boolean"
      || i > 0 && row.day <= days[i - 1]!.day)
    || !(payload.x.baseline === null || typeof payload.x.baseline === "number" && payload.x.baseline >= 0)
    || !Array.isArray(payload.stance) || payload.stance.some((row) => !day(row.day) || !stance(row.score) || !Number.isInteger(row.posts))
    || !Array.isArray(payload.topPosts) || !payload.topPosts.every(validPost)
    || payload.wikipedia !== undefined && !validWikipedia(payload.wikipedia)
    || payload.reddit !== undefined && !validReddit(payload.reddit)
    || !Array.isArray(payload.pending) || !Array.isArray(payload.warnings) || payload.warnings.some((warning) => typeof warning !== "string"))
    throw new Error("Gloom Cloud returned invalid social mention history");
  return payload;
}

export async function fetchSocialMentions(symbol: string, range: SocialMentionsRange = "1y",
  client: Pick<typeof apiClient, "getCloudSocialMentions"> = apiClient): Promise<SocialMentionsPayload> {
  try { return validateSocialMentions(await client.getCloudSocialMentions(symbol, range), symbol, range); }
  catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) throw new Error("Social mentions are not available on this Gloom Cloud server yet");
    throw error;
  }
}
export interface SocialMentionsResource { payload: SocialMentionsPayload; stale: boolean; refreshError: string | null }
const cacheKey = (symbol: string, range: SocialMentionsRange) => `${range}:${symbol}`;
export function cachedSocialMentions(symbol: string, range: SocialMentionsRange): SocialMentionsResource | null {
  const cached = socialMentionsCache.get(cacheKey(symbol, range), { allowExpired: true });
  if (!cached) return null;
  try { return { payload: validateSocialMentions(cached.data, symbol, range), stale: false, refreshError: null }; }
  catch { return null; }
}
export async function loadSocialMentions(symbol: string, range: SocialMentionsRange, force = false): Promise<SocialMentionsResource> {
  const result = await socialMentionsCache.load(cacheKey(symbol, range), () => fetchSocialMentions(symbol, range), { force });
  if (result.error instanceof ApiRequestError && [401, 403].includes(result.error.status ?? 0)) throw result.error;
  return { payload: validateSocialMentions(result.data, symbol, range), stale: result.stale, refreshError: result.refreshError ?? null };
}

export async function loadSocialMentionPosts(symbol: string, date: string): Promise<SocialMentionPost[]> {
  const result = await socialMentionPostsCache.load(`${symbol}:${date}`, async () => {
    const data = await apiClient.getCloudSocialMentionPosts(symbol, date);
    if (data?.symbol !== symbol || data.day !== date || !Array.isArray(data.posts) || !data.posts.every(validPost))
      throw new Error("Gloom Cloud returned invalid social posts");
    return data;
  });
  if (result.error && !result.data) throw result.error;
  return result.data.posts;
}
