import { expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import type { SocialMentionPost, SocialMentionsPayload } from "../../../api-client/social-mentions";
import { fetchSocialMentions, validateSocialMentions } from "./client";
import { socialDayRows, socialRatio, socialStance, socialSummary, sortedSocialRows, stanceWord, topPostCell } from "./model";

const post = (id: string, day: string, views: number | null, stance: number | null = .5): SocialMentionPost => ({
  id, day, author: "trader", text: `$NVDA  ${id}\nline`, postedAt: `${day}T15:00:00.000Z`, views, likes: 4, reposts: 1, replies: 0,
  url: `https://x.com/trader/status/${id}`, stance,
});
function fixture(): SocialMentionsPayload {
  return {
    symbol: "NVDA", range: "1y", asOf: "2026-09-27T12:00:00.000Z",
    x: { days: [
      { day: "2026-09-24", mentions: 100, closed: true },
      { day: "2026-09-25", mentions: 400, closed: true },
      { day: "2026-09-26", mentions: 150, closed: true },
      { day: "2026-09-27", mentions: 60, closed: false },
    ], historyFrom: "2025-09-27", completeThrough: "2026-09-26", baseline: 100, refreshedAt: "2026-09-27T12:00:00.000Z" },
    stance: [{ day: "2026-09-25", score: .6, posts: 18 }, { day: "2026-09-26", score: -.3, posts: 2 }],
    topPosts: [post("2", "2026-09-25", 900), post("1", "2026-09-25", 5_000), post("3", "2026-09-26", null, null)],
    wikipedia: { article: "Nvidia", baseline: 5_000, days: [{ day: "2026-09-25", views: 9_000 }, { day: "2026-09-26", views: 6_000 }] },
    reddit: { baseline: 10, days: [{ day: "2026-09-25", mentions: 30 }, { day: "2026-09-26", mentions: 5 }] },
    pending: [], warnings: [],
  };
}

test("rows join the median, stance and the most viewed post of each day", () => {
  const data = validateSocialMentions(fixture(), "NVDA", "1y");
  const rows = socialDayRows(data);
  expect(rows[1]).toMatchObject({ day: "2026-09-25", ratio: 4, stance: .6, wikiViews: 9_000 });
  expect(rows[0]!.wikiViews).toBeNull();
  expect(rows[1]!.topPost!.id).toBe("1");
  expect(topPostCell(rows[1]!.topPost)).toBe("@trader $NVDA 1 line");
  expect(sortedSocialRows(rows, { column: "mentions", direction: "desc" }).map((row) => row.day)[0]).toBe("2026-09-25");
  expect(sortedSocialRows(rows, { column: "stance", direction: "desc" }).map((row) => row.stance)).toEqual([.6, -.3, null, null]);
  const summary = socialSummary(data, rows);
  expect(summary.latest!.day).toBe("2026-09-26");
  expect(summary.peak!.mentions).toBe(400);
  expect(summary.stance).toBe(.51);
  expect(summary.wiki).toEqual({ day: "2026-09-26", views: 6_000, ratio: 1.2 });
  expect(summary.reddit).toEqual({ day: "2026-09-26", mentions: 5, ratio: .5 });
  expect(rows.map((row) => row.redditMentions)).toEqual([null, 30, 5, null]);
  expect([socialRatio(4), socialRatio(12.4), socialStance(.5), socialStance(null), stanceWord(-.2)]).toEqual(["4.0x", "12x", "+0.50", "--", "bearish"]);
});

test("the Cloud boundary rejects unordered days, bad stances and non-X links", () => {
  const unordered = fixture(); unordered.x.days.reverse();
  expect(() => validateSocialMentions(unordered, "NVDA", "1y")).toThrow();
  const stance = fixture(); stance.stance[0]!.score = 3;
  expect(() => validateSocialMentions(stance, "NVDA", "1y")).toThrow();
  const link = fixture(); link.topPosts[0]!.url = "https://evil.example/x";
  expect(() => validateSocialMentions(link, "NVDA", "1y")).toThrow();
  expect(() => validateSocialMentions(fixture(), "NVDA", "5y")).toThrow();
  const wiki = fixture(); wiki.wikipedia!.days[1]!.views = -1;
  expect(() => validateSocialMentions(wiki, "NVDA", "1y")).toThrow();
  const older = fixture(); delete older.wikipedia;
  expect(socialDayRows(validateSocialMentions(older, "NVDA", "1y"))[1]!.wikiViews).toBeNull();
});

test("a server without the endpoint reads as unavailable while sign-in errors pass through", async () => {
  await expect(fetchSocialMentions("NVDA", "1y", { getCloudSocialMentions: async () => { throw new ApiRequestError("missing", 404); } }))
    .rejects.toThrow("not available");
  const denied = new ApiRequestError("Unauthorized", 401);
  await expect(fetchSocialMentions("NVDA", "1y", { getCloudSocialMentions: async () => { throw denied; } })).rejects.toBe(denied);
});
