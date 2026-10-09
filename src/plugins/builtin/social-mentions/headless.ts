import type { SocialMentionsRange } from "../../../api-client/social-mentions";
import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchSocialMentions } from "./client";
import { socialCount, socialDayRows, socialRatio, socialStance, topPostCell } from "./model";

export const socialMentionsHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "ticker", description: "Ticker with a searchable cashtag (up to six letters and digits).", placeholder: "ticker" },
  freshness: { source: "X posts", status: "not-a-feed", basis: "daily post counts" },
  discovery: { aliases: ["BUZZ"], dataRequirements: ["Gloom Cloud X mention history"],
    limitations: ["Daily $cashtag posts on X in UTC days, spam included", "Top posts and stance cover days that were looked up", "Views exist from 2022-12-22"] },
  options: [
    { key: "range", type: "enum", description: "History window.", values: [{ value: "1y" }, { value: "5y" }, { value: "max" }], defaultValue: "1y", settingKey: "socialRange" },
  ],
  describe: (args) => `Social mentions | ${args.symbols[0]}`,
  async load(args, ctx) {
    const range = (["1y", "5y", "max"].includes(String(args.options.range)) ? args.options.range : "1y") as SocialMentionsRange;
    const data = await fetchSocialMentions(String(args.symbols[0]).toUpperCase(), range, ctx.apiClient);
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
