import type { SocialMentionsRange, SocialOutlierRow } from "../../../api-client/social-mentions";
import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { explainRefusal } from "../shared/cloud-denied";
import { REPORT_ROWS } from "../shared/headless-options";
import { fetchSocialMentions } from "./client";
import { socialMentionsLockNote } from "./lock-note";
import { socialCount, socialDayRows, socialRatio, socialStance, topPostCell } from "./model";
import { DEFAULT_SOCIAL_OUTLIERS_QUERY, loadSocialOutliers, SOCIAL_OUTLIER_PANE_ROWS } from "./outliers-client";
import {
  outlierCountedAt,
  outlierPrice,
  SOCIAL_OUTLIER_CAP_OPTIONS,
  SOCIAL_OUTLIERS_TITLE,
  socialOutliersEmptyTitle,
  socialOutliersFiltered,
  socialOutliersQueryFrom,
} from "./outliers-model";

/** The ranking's options set the pane's own state, so `gloom shot BUZZ --window today` draws what `fn` lists. */
const OUTLIER_OPTION_STATE = (key: string) => ({ pluginId: "ticker-research", key: `social-mentions:outliers:${key}` });

const outlierRow = (row: SocialOutlierRow) => ({
  symbol: row.symbol,
  company: row.name,
  day: row.day,
  countedAt: row.countedAt,
  posts: row.mentions,
  median: row.baseline,
  ratio: row.ratio,
  stance: row.stance,
  stancePosts: row.stancePosts,
  pricePct: row.price?.changePct ?? null,
  priceAsOf: row.price?.asOf ?? null,
  marketCap: row.marketCap,
});

export const socialMentionsHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "ticker", optional: true, placeholder: "ticker",
    description: "Ticker with a searchable cashtag (up to six letters and digits); omit for the tickers whose posts jump above their own 30-day median." },
  freshness: { source: "X posts", status: "not-a-feed", basis: "daily post counts" },
  discovery: { aliases: ["BUZZ"], dataRequirements: ["Free Gloom sign-in", "Gloom Cloud X mention history"],
    limitations: ["Daily $cashtag posts on X in UTC days, spam included.", "Top posts and stance cover days that were looked up.", "Views exist from 2022-12-22."] },
  options: [
    { key: "range", type: "enum", description: "History window.", values: [{ value: "1y" }, { value: "5y" }, { value: "max" }], defaultValue: "1y", settingKey: "socialRange" },
    { key: "window", type: "enum", description: "Without a ticker: each ticker's latest closed UTC day (day), or today's posts so far (today).",
      values: [{ value: "day", aliases: ["latest", "closed"] }, { value: "today" }], defaultValue: "day",
      example: "--window today", exampleWithoutArgument: true, pluginState: OUTLIER_OPTION_STATE("window") },
    { key: "minPosts", aliases: ["min-posts", "min"], type: "integer", minimum: 0, maximum: 1_000_000, defaultValue: DEFAULT_SOCIAL_OUTLIERS_QUERY.minPosts,
      description: "Without a ticker: least posts on the day counted.", pluginState: OUTLIER_OPTION_STATE("minPosts") },
    { key: "cap", type: "enum", description: "Without a ticker: market value, micro (under $300M), small ($300M to $2B), mid ($2B to $10B) or large.",
      values: SOCIAL_OUTLIER_CAP_OPTIONS.map((option) => ({ value: option.value })), example: "--cap small --min-posts 100", exampleWithoutArgument: true,
      pluginState: OUTLIER_OPTION_STATE("cap") },
    { key: "limit", shot: REPORT_ROWS, aliases: ["count", "rows"], type: "integer", minimum: 1, maximum: 200, defaultValue: SOCIAL_OUTLIER_PANE_ROWS,
      description: "Without a ticker: tickers to rank." },
  ],
  describe: (args) => args.symbols[0]
    ? `Social mentions | ${args.symbols[0]}`
    : `${SOCIAL_OUTLIERS_TITLE} | ${args.options.window === "today" ? "Today" : "Latest day"}`,
  async load(args, ctx) {
    if (!args.symbols[0]) {
      // The ranking's query as the pane reads it from the same state.
      const query = socialOutliersQueryFrom(args.options);
      const data = (await loadSocialOutliers(query, { limit: Number(args.options.limit) || SOCIAL_OUTLIER_PANE_ROWS,
        force: ctx.refresh === true, client: ctx.apiClient, names: ctx.marketData, signal: ctx.signal })
        .catch(async (error: unknown) => { throw await explainRefusal(error, socialMentionsLockNote, { symbol: null, context: ctx }); })).payload;
      const today = data.window === "today";
      return { complete: true,
        sections: [{ title: today ? "Today's posts on X against their 30-day median" : "Latest day's posts on X against their 30-day median", columns: [
          { key: "symbol", header: "Ticker" },
          { key: "company", header: "Company", format: (value) => typeof value === "string" ? value : "--" },
          today
            ? { key: "countedAt", header: "As of", format: (value) => outlierCountedAt({ countedAt: String(value) }) }
            : { key: "day", header: "Date" },
          { key: "posts", header: "Posts", align: "right", format: (value) => socialCount(value as number) },
          { key: "median", header: "30D median", align: "right", format: (value) => socialCount(value as number) },
          { key: "ratio", header: "Vs median", align: "right", format: (value) => socialRatio(value as number) },
          { key: "stance", header: "Stance", align: "right", format: (value) => socialStance(value as number | null) },
          { key: "pricePct", header: "Price %", align: "right",
            format: (value) => outlierPrice({ price: typeof value === "number" ? { changePct: value, asOf: "" } : null }) },
        ], rows: data.rows.map(outlierRow), rowSymbolKey: "symbol", rowAsOfKey: today ? "countedAt" : "day",
        ...(data.rows.length ? {} : { empty: socialOutliersEmptyTitle(data.window, data.freshFrom, socialOutliersFiltered(query)) }) }],
        metadata: { window: data.window, freshFrom: data.freshFrom, filters: data.filters, coverage: data.coverage, asOf: data.asOf,
          limitations: ["Each ticker is ranked on its own latest closed UTC day, or today so far; tickers last counted before freshFrom are left out.",
            "The median is floored at one post a day."] },
      };
    }
    const range = (["1y", "5y", "max"].includes(String(args.options.range)) ? args.options.range : "1y") as SocialMentionsRange;
    const symbol = String(args.symbols[0]).toUpperCase();
    const data = await fetchSocialMentions(symbol, range, ctx.apiClient)
      .catch(async (error: unknown) => { throw await explainRefusal(error, socialMentionsLockNote, { symbol, context: ctx }); });
    return { complete: !data.pending.length, errors: data.warnings,
      sections: [{ title: "Daily posts on X", columns: [
        { key: "day", header: "Date" },
        { key: "mentions", header: "Posts", align: "right", format: (value) => socialCount(value as number) },
        { key: "ratio", header: "Vs median", align: "right", format: (value) => socialRatio(value as number | null) },
        { key: "stance", header: "Stance", align: "right", format: (value) => socialStance(value as number | null) },
        { key: "topPost", header: "Top post", format: (value) => topPostCell(value as never) },
      ], rows: socialDayRows(data).toReversed().map((row) => ({ ...row })) }],
      metadata: { symbol: data.symbol, range: data.range, baseline: data.x.baseline, asOf: data.asOf },
    };
  },
};
