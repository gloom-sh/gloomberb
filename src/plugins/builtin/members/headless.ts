import type { HeadlessPaneColumn, HeadlessPaneDefinition } from "../../../types/plugin";
import type { HeadlessRowsResult } from "../../../types/headless";
import { fetchBreadth, fetchChanges, fetchFunds, fetchMembers, fetchStockFunds, FundNotCoveredError } from "./client";
import type { FundMembersPayload } from "../../../api-client/members";
import { canonicalFund, changeReason, coverageText, decimal, DEFAULT_SORT, fundName, fundSource, holdingsCaveats, holdingsSourceText, memberRows, membersFeed,
  noStockFundsMessage, percent, stockFundsNotices, usListingInput } from "./model";
const columns: HeadlessPaneColumn[] = [
  { key: "symbol", header: "Ticker" }, { key: "name", header: "Name" },
  { key: "weight", header: "Weight %", align: "right", format: (value) => value == null ? "--" : decimal(Number(value) * 100) },
  { key: "shares", header: "Shares", align: "right", format: (value) => decimal(value as number | null, 0) },
  { key: "price", header: "Price $", align: "right", format: (value) => decimal(value as number | null) },
  ...["changePercent", "return1WPercent", "return1MPercent", "returnYtdPercent"].map((key, i) => ({ key, header: ["1D", "1W", "1M", "YTD"][i]!, align: "right" as const, format: (value: unknown) => percent(value as number | null) })),
];
/** A column CSV and JSON carry on every row and the text table leaves to its notices: what the holdings are as of. */
const exported = (key: string, header: string): HeadlessPaneColumn => ({ key, header, minTableWidth: Number.MAX_SAFE_INTEGER });
/**
 * What a fund's holdings are as of on each of its rows, so an exported row read alone says it: the date, and an
 * N-PORT report's filing day and link.
 */
function holdingsBasis(data: Pick<FundMembersPayload, "asOf" | "basis" | "filedOn" | "sourceUrl">) {
  const nport = data.basis === "nport";
  return {
    fields: { holdingsAsOf: data.asOf.slice(0, 10), ...nport ? { filedOn: data.filedOn ?? null, sourceUrl: data.sourceUrl ?? null } : {} },
    columns: [exported("holdingsAsOf", "Holdings as of"), ...nport ? [exported("filedOn", "Filed"), exported("sourceUrl", "Source link")] : []],
  };
}
/**
 * `fn MEMB NVDA`: the covered funds whose holdings hold a stock, the funds on daily files first, then
 * those read from N-PORT reports, each with its weight and what its holdings are as of.
 */
async function stockFunds(input: string, client: Parameters<typeof fetchStockFunds>[1]): Promise<HeadlessRowsResult> {
  const symbol = usListingInput(input);
  if (!symbol) {
    return { freshness: { status: "not-a-feed", basis: "fund holdings" }, rows: [], columns: [],
      empty: "Funds are looked through by US ticker: name the US listing (an ADR such as INFY or TSM)." };
  }
  const data = await fetchStockFunds(symbol, client);
  const none = noStockFundsMessage(symbol);
  return { freshness: { status: "not-a-feed", basis: "fund holdings" },
    rows: data.funds.map((row) => ({ ...row, weight: row.weight === null ? null : row.weight * 100, source: fundSource(row),
      filedOn: row.filedOn ?? null, sourceUrl: row.sourceUrl ?? null })),
    columns: [{ key: "ticker", header: "Fund" }, { key: "name", header: "Index or theme" },
      { key: "weight", header: "Weight %", align: "right", format: (value) => decimal(value as number | null) },
      { key: "asOf", header: "Holdings as of" }, { key: "source", header: "Source" }, exported("filedOn", "Filed"), exported("sourceUrl", "Source link")],
    empty: `${none.title} ${none.message}`,
    metadata: { symbol: data.symbol, coverage: data.coverage, notices: stockFundsNotices(data) } };
}

export const membersHeadless: HeadlessPaneDefinition<"rows"> = {
  shape: "rows", argument: { kind: "free-text", optional: true, placeholder: "fund or stock", description: "Covered fund or index alias for its holdings, a US stock for the funds holding it; omit for the fund list." },
  options: [{ key: "tab", type: "enum", values: [{ value: "members" }, { value: "movers" }, { value: "changes" }, { value: "breadth" }], defaultValue: "members", description: "Members, movers, changes or daily breadth." }],
  discovery: { aliases: ["MEMB", "MRR", "IMOV"], limitations: ["ETF holdings, with file dates.", "Thematic funds from SEC N-PORT reports, two to four months old.", "Member prices are real-time with Pro and fifteen minutes delayed otherwise; partial 1D coverage.", "Nasdaq-100 is not covered.", "Breadth history uses current members (survivorship bias)."] },
  describe: (args) => args.rawArgument ? `MEMB ${args.rawArgument}` : "Index and ETF members",
  async load(args, context) {
    const input = args.symbols[0] ?? args.rawArgument ?? "";
    if (!input) return { freshness: { status: "not-a-feed", basis: "fund holdings files" },
      rows: (await fetchFunds(context.apiClient)).funds.map((fund) => ({ ...fund, name: fundName(fund), source: fundSource(fund), filedOn: fund.filedOn ?? null })),
      columns: [{ key: "ticker", header: "Fund" }, { key: "name", header: "Index or theme" }, { key: "asOf", header: "Holdings as of" }, { key: "source", header: "Source" },
        exported("filedOn", "Filed")] };
    const fund = canonicalFund(input);
    // A symbol the covered list does not hold is a stock to look the funds through for, whatever the tab.
    const covered = await fetchFunds(context.apiClient).then((payload) => payload.funds, () => {
      // Intentional ignore: the fund read below reports the same failure, so the input stays a fund.
      return null;
    });
    if (covered && !covered.some((row) => row.ticker === fund || row.aliases.some((alias) => alias.toUpperCase() === fund))) return stockFunds(input, context.apiClient);
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
      // An empty table says why: the fund's index changes are not followed, or none is stored, as the pane says.
      return { freshness: { status: "not-a-feed", basis: "index changes" }, rows: data.changes.map((row) => ({ ...row, reason: changeReason(row) })), columns: [{ key: "effectiveDate", header: "Effective" }, { key: "added", header: "Added" }, { key: "removed", header: "Removed" }, { key: "daysToGo", header: "In days", align: "right" }, { key: "reason", header: "Reason" }],
        empty: data.available ? "No stored index changes." : `Index changes are not covered for ${data.fund.ticker}.`,
        complete: data.available && !data.stale, metadata: { ...data, changes: undefined } };
    }
    const data = await fetchMembers(fund, context.apiClient).catch((error: unknown) => {
      if (error instanceof FundNotCoveredError) return null;
      throw error;
    });
    if (!data) return stockFunds(input, context.apiClient);
    const movers = args.options.tab === "movers";
    const basis = holdingsBasis(data);
    const rows = memberRows(data.members, movers ? "movers" : "members", "", DEFAULT_SORT).flatMap((row) => row.kind === "item" ? [{ ...row.item, ...basis.fields }] : []);
    // Member prices are the pane's quotes: real-time for a Pro account, 15 minutes delayed otherwise. As in the
    // pane, the fund's snapshot says whether it is stale; the members' own flags are not what the pane reads.
    const live = data.access === "realtime";
    // Outside the regular session a Pro account's members are the session's close, not a live feed: the report
    // is as of that close and says no feed, as the pane's footer names the close instead of "live".
    const feed = membersFeed(data.access, Date.now());
    const closed = feed.kind === "close";
    // With no member quotes the report is the holdings alone: dated by them, and no feed (an N-PORT fund's would read months old and delayed).
    const status = data.stale ? { status: "stale" as const, delayMinutes: 15 } : data.quotesUnavailable ? { status: "not-a-feed" as const, basis: "fund holdings" }
      : closed ? {} : { status: live ? "live" as const : "delayed" as const, delayMinutes: 15 };
    return { freshness: { ...status, ignoreStaleFlags: true }, rows,
      columns: [...movers ? [...columns.slice(0, 3), { key: "contribution", header: "Contrib. pp", align: "right" as const, format: (value: unknown) => percent(value as number | null, "", 3) }] : columns,
        ...basis.columns],
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
