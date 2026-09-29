import type { SocialMentionPost, SocialMentionsPayload } from "../../../api-client/social-mentions";
import type { DataTableColumn } from "../../../components";
import { formatCompact } from "../../../utils/format";

export interface SocialDayRow {
  day: string;
  mentions: number;
  closed: boolean;
  /** Posts over the 30-day median. */
  ratio: number | null;
  stance: number | null;
  topPost: SocialMentionPost | null;
  /** Views of the company's Wikipedia article that day. */
  wikiViews: number | null;
  /** Reddit posts and comments naming it, once every subreddit finished the day. */
  redditMentions: number | null;
}

export const socialCount = (value: number | null | undefined) =>
  value == null ? "--" : Math.abs(value) >= 10_000 ? formatCompact(value) : Math.round(value).toLocaleString("en-US");
export const socialRatio = (value: number | null) => value == null ? "--" : `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}x`;
export const socialStance = (value: number | null) => value == null ? "--" : `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
export const stanceWord = (value: number | null) => value == null ? undefined : value >= .15 ? "bullish" : value <= -.15 ? "bearish" : "mixed";

export function socialDayRows(data: SocialMentionsPayload): SocialDayRow[] {
  const stance = new Map(data.stance.map((row) => [row.day, row.score]));
  const top = new Map<string, SocialMentionPost>();
  for (const post of data.topPosts) {
    const current = top.get(post.day);
    if (!current || (post.views ?? -1) > (current.views ?? -1)) top.set(post.day, post);
  }
  const median = data.x.baseline;
  const wiki = new Map((data.wikipedia?.days ?? []).map((row) => [row.day, row.views]));
  const reddit = new Map((data.reddit?.days ?? []).map((row) => [row.day, row.mentions]));
  return data.x.days.map((row) => ({
    ...row,
    ratio: median && median > 0 ? row.mentions / median : null,
    stance: stance.get(row.day) ?? null,
    topPost: top.get(row.day) ?? null,
    wikiViews: wiki.get(row.day) ?? null,
    redditMentions: reddit.get(row.day) ?? null,
  }));
}

export type SocialColumnId = "day" | "mentions" | "ratio" | "wikiViews" | "redditMentions" | "stance" | "topPost";
export type SocialColumn = Omit<DataTableColumn, "id"> & { id: SocialColumnId };
export const SOCIAL_COLUMNS: SocialColumn[] = [
  { id: "day", label: "DATE", width: 12, align: "left" },
  { id: "mentions", label: "POSTS", width: 9, align: "right" },
  { id: "ratio", label: "VS MEDIAN", width: 10, align: "right" },
  { id: "wikiViews", label: "WIKI", width: 8, align: "right" },
  { id: "redditMentions", label: "REDDIT", width: 8, align: "right" },
  { id: "stance", label: "STANCE", width: 8, align: "right" },
  { id: "topPost", label: "TOP POST", width: 24, flexGrow: 1, align: "left" },
];
export interface SocialSort { column: SocialColumnId; direction: "asc" | "desc" }

export function sortedSocialRows(rows: SocialDayRow[], sort: SocialSort): SocialDayRow[] {
  const value = (row: SocialDayRow): string | number | null => sort.column === "day" ? row.day
    : sort.column === "topPost" ? row.topPost?.views ?? null : row[sort.column];
  return rows.toSorted((a, b) => {
    const left = value(a), right = value(b);
    if (left == null || right == null) return left == null ? right == null ? b.day.localeCompare(a.day) : 1 : -1;
    return (left < right ? -1 : left > right ? 1 : 0) * (sort.direction === "asc" ? 1 : -1) || b.day.localeCompare(a.day);
  });
}

export const topPostCell = (post: SocialMentionPost | null) =>
  post ? `@${post.author} ${post.text.replace(/\s+/g, " ").trim()}` : "";

export function socialSummary(data: SocialMentionsPayload, rows: SocialDayRow[]) {
  const latest = rows.findLast((row) => row.closed) ?? null;
  const peak = rows.reduce<SocialDayRow | null>((best, row) => !best || row.mentions > best.mentions ? row : best, null);
  const weekFrom = new Date(Date.parse(`${data.asOf.slice(0, 10)}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
  const week = data.stance.filter((row) => row.day >= weekFrom);
  const weight = week.reduce((sum, row) => sum + row.posts, 0);
  const stance = weight ? Math.round(week.reduce((sum, row) => sum + row.score * row.posts, 0) / weight * 100) / 100 : null;
  const wikiLast = data.wikipedia?.days.at(-1) ?? null;
  const wikiMedian = data.wikipedia?.baseline ?? null;
  const wiki = wikiLast ? { ...wikiLast, ratio: wikiMedian ? wikiLast.views / wikiMedian : null } : null;
  const redditLast = data.reddit?.days.at(-1) ?? null;
  const redditMedian = data.reddit?.baseline ?? null;
  const reddit = redditLast ? { ...redditLast, ratio: redditMedian ? redditLast.mentions / redditMedian : null } : null;
  return { latest, peak, stance, wiki, reddit };
}

export function socialChartPoints(rows: SocialDayRow[], value: (row: SocialDayRow) => number | null = (row) => row.mentions) {
  return rows.map((row) => {
    const date = new Date(`${row.day}T00:00:00Z`);
    return { date, observedAt: date, value: value(row) };
  });
}
