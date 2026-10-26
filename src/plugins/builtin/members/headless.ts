import type { HeadlessPaneColumn, HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchBreadth, fetchChanges, fetchFunds, fetchMembers } from "./client";
import { canonicalFund, changeReason, coverageText, decimal, DEFAULT_SORT, holdingsCaveats, holdingsSourceText, memberRows, membersFeed, percent } from "./model";
const columns: HeadlessPaneColumn[] = [
  { key: "symbol", header: "Ticker" }, { key: "name", header: "Name" },
  { key: "weight", header: "Weight %", align: "right", format: (value) => value == null ? "--" : decimal(Number(value) * 100) },
  { key: "shares", header: "Shares", align: "right", format: (value) => decimal(value as number | null, 0) },
  { key: "price", header: "Price $", align: "right", format: (value) => decimal(value as number | null) },
  ...["changePercent", "return1WPercent", "return1MPercent", "returnYtdPercent"].map((key, i) => ({ key, header: ["1D", "1W", "1M", "YTD"][i]!, align: "right" as const, format: (value: unknown) => percent(value as number | null) })),
];
export const membersHeadless: HeadlessPaneDefinition<"rows"> = {
  shape: "rows", argument: { kind: "free-text", optional: true, placeholder: "fund", description: "Covered fund or index alias; omit for the fund list." },
  options: [{ key: "tab", type: "enum", values: [{ value: "members" }, { value: "movers" }, { value: "changes" }, { value: "breadth" }], defaultValue: "members", description: "Members, movers, changes or daily breadth." }],
  discovery: { aliases: ["MEMB", "MRR", "IMOV"], limitations: ["ETF holdings, with file dates.", "Member prices are real-time with Pro and fifteen minutes delayed otherwise; partial 1D coverage.", "Nasdaq-100 is not covered.", "Breadth history uses current members (survivorship bias)."] },
  describe: (args) => args.rawArgument ? `MEMB ${args.rawArgument}` : "Index and ETF members",
  async load(args, context) {
    const input = args.symbols[0] ?? args.rawArgument ?? "";
    if (!input) return { freshness: { status: "not-a-feed", basis: "fund holdings files" }, rows: (await fetchFunds(context.apiClient)).funds.map((fund) => ({ ...fund })), columns: [{ key: "ticker", header: "Fund" }, { key: "name", header: "Index" }, { key: "asOf", header: "Holdings as of" }] };
    const fund = canonicalFund(input);
    if (args.options.tab === "breadth") {
      const data = await fetchBreadth(fund, context.apiClient);
      return { freshness: { status: data.stale ? "stale" : data.basis === "intraday" ? data.access === "realtime" ? "live" : "delayed" : "not-a-feed", basis: data.basis === "intraday" ? "regular session" : "daily closes", delayMinutes: 15 },
        rows: [...data.history, ...(data.basis === "intraday" && data.latest ? [data.latest] : [])].reverse().map(row => ({ ...row, above20: row.ma20.percent, above50: row.ma50.percent, above200: row.ma200.percent })),
        columns: [{ key: "date", header: "Date" }, ...["advances", "declines", "unchanged", "above20", "above50", "above200", "newHighs", "newLows", "adLine", "advanceDeclineEligible", "memberCount"].map((key, index) => ({ key, header: ["Adv", "Dec", "Unch", ">20D %", ">50D %", ">200D %", "52W high", "52W low", "A/D line", "A/D covered", "Members"][index]!, align: "right" as const }))],
        complete: !data.stale && !!data.latest && data.latest.advanceDeclineEligible === data.latest.memberCount,
        metadata: { ...data, history: undefined, notices: ["Breadth history uses current members (survivorship bias).", "History uses daily closes; percentages exclude members without the full window. 52-week records strictly break the prior 252 sessions' high/low."] } };
    }
    if (args.options.tab === "changes") {
      const data = await fetchChanges(fund, context.apiClient);
      return { freshness: { status: "not-a-feed", basis: "index changes" }, rows: data.changes.map((row) => ({ ...row, reason: changeReason(row) })), columns: [{ key: "effectiveDate", header: "Effective" }, { key: "added", header: "Added" }, { key: "removed", header: "Removed" }, { key: "daysToGo", header: "In days", align: "right" }, { key: "reason", header: "Reason" }],
        complete: data.available && !data.stale, metadata: { ...data, changes: undefined } };
    }
    const data = await fetchMembers(fund, context.apiClient);
    const movers = args.options.tab === "movers";
    const rows = memberRows(data.members, movers ? "movers" : "members", "", DEFAULT_SORT).flatMap((row) => row.kind === "item" ? [{ ...row.item }] : []);
    // Member prices are the pane's quotes: real-time for a Pro account, 15 minutes delayed otherwise. As in the
    // pane, the fund's snapshot says whether it is stale; the members' own flags are not what the pane reads.
    const live = data.access === "realtime";
    // Outside the regular session a Pro account's members are the session's close, not a live feed: the report
    // is as of that close and says no feed, as the pane's footer names the close instead of "live".
    const feed = membersFeed(data.access, Date.now());
    const closed = feed.kind === "close";
    const status = data.stale ? { status: "stale" as const, delayMinutes: 15 } : closed ? {} : { status: live ? "live" as const : "delayed" as const, delayMinutes: 15 };
    return { freshness: { ...status, ignoreStaleFlags: true }, rows, columns: movers ? [...columns.slice(0, 3), { key: "contribution", header: "Contrib. pp", align: "right", format: (value) => percent(value as number | null, "", 3) }] : columns,
      complete: !data.stale && data.aggregate.fresh1D === data.aggregate.total,
      unavailableSymbols: data.members.flatMap((row) => row.symbol && row.changePercent === null ? [row.symbol] : []),
      metadata: { fund: data.fund, asOf: data.asOf, ...(closed ? { sessionExchange: "NYSE", observedAt: new Date(feed.closedAt).toISOString() } : {}), snapshotAsOf: data.snapshotAsOf, aggregate: data.aggregate, stale: data.stale, notices: [
        holdingsSourceText(input, data),
        // The pane's coverage figure, and once what the table's dashes mean instead of leaving them bare.
        [coverageText(data.aggregate), data.aggregate.fresh1D < data.aggregate.total ? `1D -- means no fresh ${live ? "" : "delayed "}quote; those holdings are not counted` : ""].filter(Boolean).join(" | "),
        ...holdingsCaveats(data, movers),
      ] } };
  },
};
