import { unavailableText } from "../../../components/ui/status";
import { apiClient } from "../../../api-client";
import { isAccessDenied } from "../../../api-client/errors";
import type { SocialMentionDayPosts, SocialMentionPost, SocialMentionsPayload, SocialMentionsRange } from "../../../api-client/social-mentions";
import { createPluginCache } from "../../../data/plugin-cache";
import { isCalendarDay, isFiniteNumber, isNonNegative, isNonNegativeInt, isNullableString, isStringArray } from "../../../utils/guards";
import { CLOUD_SESSION_REQUIRED } from "../shared/research-cloud-session";
import { createCloudEndpoint, type CloudResource } from "../shared/cloud-resource";

// A closed day's top posts only change by a few views; keep them a week.
export const socialMentionPostsCache = createPluginCache<SocialMentionDayPosts>({
  kind: "social-mention-posts", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 24 * 60 * 60_000, expireMs: 7 * 24 * 60 * 60_000 },
});

const count = (value: unknown) => value === null || isNonNegativeInt(value);
const stance = (value: unknown) => isFiniteNumber(value) && value >= -1 && value <= 1;
const ascendingCounts = <T extends { day: string }>(rows: readonly T[] | undefined, read: (row: T) => unknown) =>
  Array.isArray(rows) && rows.every((row: T, i) => isCalendarDay(row.day) && isNonNegativeInt(read(row)) && (i === 0 || row.day > rows[i - 1]!.day));
function validPost(post: SocialMentionPost): boolean {
  return !!post && /^\d{1,24}$/.test(post.id) && isCalendarDay(post.day) && typeof post.author === "string" && typeof post.text === "string"
    && Number.isFinite(Date.parse(post.postedAt)) && [post.views, post.likes, post.reposts, post.replies].every(count)
    && typeof post.url === "string" && post.url.startsWith("https://x.com/") && (post.stance === null || stance(post.stance));
}

function validWikipedia(wiki: NonNullable<SocialMentionsPayload["wikipedia"]>): boolean {
  return !!wiki && isNullableString(wiki.article) && ascendingCounts(wiki.days, (row: { views: unknown }) => row.views)
    && (wiki.baseline === null || isNonNegative(wiki.baseline));
}

function validReddit(reddit: NonNullable<SocialMentionsPayload["reddit"]>): boolean {
  return !!reddit && ascendingCounts(reddit.days, (row: { mentions: unknown }) => row.mentions)
    && (reddit.baseline === null || isNonNegative(reddit.baseline));
}

/** Days ascending and unique, counts whole, stances in range, posts linking to X only. */
export function validateSocialMentions(payload: SocialMentionsPayload, symbol: string, range: SocialMentionsRange): SocialMentionsPayload {
  const days = payload?.x?.days;
  if (!payload || payload.symbol !== symbol || payload.range !== range || !Array.isArray(days)
    || days.some((row, i) => !isCalendarDay(row.day) || !isNonNegativeInt(row.mentions) || typeof row.closed !== "boolean"
      || i > 0 && row.day <= days[i - 1]!.day)
    || !(payload.x.baseline === null || isNonNegative(payload.x.baseline))
    || !Array.isArray(payload.stance) || payload.stance.some((row) => !isCalendarDay(row.day) || !stance(row.score) || !Number.isInteger(row.posts))
    || !Array.isArray(payload.topPosts) || !payload.topPosts.every(validPost)
    || payload.wikipedia !== undefined && !validWikipedia(payload.wikipedia)
    || payload.reddit !== undefined && !validReddit(payload.reddit)
    || !Array.isArray(payload.pending) || !isStringArray(payload.warnings))
    throw new Error("Social mention history is invalid");
  return payload;
}

export type SocialMentionsResource = CloudResource<SocialMentionsPayload>;

const socialMentionsEndpoint = createCloudEndpoint<{ symbol: string; range: SocialMentionsRange }, SocialMentionsPayload, Pick<typeof apiClient, "getCloudSocialMentions">>({
  kind: "social-mentions", schemaVersion: 1, policy: { staleMs: 15 * 60_000, expireMs: 7 * 24 * 60 * 60_000 },
  key: ({ symbol, range }) => `${range}:${symbol}`, defaultClient: apiClient,
  fetch: ({ symbol, range }, client) => client.getCloudSocialMentions(symbol, range),
  validate: (payload, { symbol, range }) => validateSocialMentions(payload, symbol, range),
  unavailableMessage: unavailableText("social mentions"),
});

export const socialMentionsCache = socialMentionsEndpoint.cache;
export const fetchSocialMentions = (symbol: string, range: SocialMentionsRange = "1y", client: Pick<typeof apiClient, "getCloudSocialMentions"> = apiClient) =>
  socialMentionsEndpoint.fetch({ symbol, range }, { client });
export const cachedSocialMentions = (symbol: string, range: SocialMentionsRange): SocialMentionsResource | null =>
  socialMentionsEndpoint.cached({ symbol, range });
export const loadSocialMentions = (symbol: string, range: SocialMentionsRange, force = false): Promise<SocialMentionsResource> =>
  socialMentionsEndpoint.load({ symbol, range }, { force });

/**
 * What the pane's sign-in wall keys on. The route answers a missing or
 * unverified session with a bare 401/403, which the pane would show as a failure.
 */
export const asSessionRequired = (error: unknown) => isAccessDenied(error) ? new Error(CLOUD_SESSION_REQUIRED, { cause: error }) : error;

export async function loadSocialMentionPosts(symbol: string, date: string): Promise<SocialMentionPost[]> {
  const result = await socialMentionPostsCache.load(`${symbol}:${date}`, async () => {
    const data = await apiClient.getCloudSocialMentionPosts(symbol, date);
    if (data?.symbol !== symbol || data.day !== date || !Array.isArray(data.posts) || !data.posts.every(validPost))
      throw new Error("Social posts are invalid");
    return data;
  });
  if (result.error && !result.data) throw result.error;
  return result.data.posts;
}
