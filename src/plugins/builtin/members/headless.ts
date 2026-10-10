import type { HeadlessPaneColumn, HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchChanges, fetchFunds, fetchMembers } from "./client";
import { canonicalFund, changeReason, decimal, DEFAULT_SORT, memberRows, percent } from "./model";
const columns: HeadlessPaneColumn[] = [
  { key: "symbol", header: "Ticker" }, { key: "name", header: "Name" },
  { key: "weight", header: "Weight %", align: "right", format: (value) => value == null ? "--" : decimal(Number(value) * 100) },
  { key: "shares", header: "Shares", align: "right", format: (value) => decimal(value as number | null, 0) },
  { key: "price", header: "Price $", align: "right", format: (value) => decimal(value as number | null) },
  ...["changePercent", "return1WPercent", "return1MPercent", "returnYtdPercent"].map((key, i) => ({ key, header: ["1D", "1W", "1M", "YTD"][i]!, align: "right" as const, format: (value: unknown) => percent(value as number | null) })),
];
export const membersHeadless: HeadlessPaneDefinition<"rows"> = {
  shape: "rows", argument: { kind: "ticker", optional: true, placeholder: "fund", description: "Covered fund or index alias; omit for the fund list." },
  options: [{ key: "tab", type: "enum", values: [{ value: "members" }, { value: "movers" }, { value: "changes" }], defaultValue: "members", description: "Members, movers or changes." }],
  discovery: { aliases: ["MEMB", "MRR", "IMOV"], limitations: ["ETF holdings, with file dates", "Partial delayed member return coverage", "Nasdaq-100 is not covered"] },
  describe: (args) => args.rawArgument ? `MEMB ${args.rawArgument}` : "Index and ETF members",
  async load(args, context) {
    const input = args.symbols[0] ?? args.rawArgument ?? "";
    if (!input) return { freshness: { status: "not-a-feed", basis: "fund holdings files" }, rows: (await fetchFunds(context.apiClient)).funds.map((fund) => ({ ...fund })), columns: [{ key: "ticker", header: "Fund" }, { key: "name", header: "Index" }, { key: "asOf", header: "Holdings as of" }] };
    const fund = canonicalFund(input);
    if (args.options.tab === "changes") {
      const data = await fetchChanges(fund, context.apiClient);
      return { freshness: { status: "not-a-feed", basis: "index changes" }, rows: data.changes.map((row) => ({ ...row, reason: changeReason(row) })), columns: [{ key: "effectiveDate", header: "Effective" }, { key: "added", header: "Added" }, { key: "removed", header: "Removed" }, { key: "daysToGo", header: "In days", align: "right" }, { key: "reason", header: "Reason" }],
        complete: data.available && !data.stale, metadata: { ...data, changes: undefined } };
    }
    const data = await fetchMembers(fund, context.apiClient);
    const movers = args.options.tab === "movers";
    const rows = memberRows(data.members, movers ? "movers" : "members", "", DEFAULT_SORT).flatMap((row) => row.kind === "item" ? [{ ...row.item }] : []);
    // Member prices are the pane's 15-minute delayed quotes. As in the pane, the fund's snapshot says
    // whether it is stale; the members' own flags are not what the pane reads.
    return { freshness: { status: data.stale ? "stale" : "delayed", delayMinutes: 15, ignoreStaleFlags: true }, rows, columns: movers ? [...columns.slice(0, 3), { key: "contribution", header: "Contrib. pp", align: "right", format: (value) => percent(value as number | null, "", 3) }] : columns,
      complete: !data.stale && data.aggregate.fresh1D === data.aggregate.total,
      unavailableSymbols: data.members.flatMap((row) => row.symbol && row.changePercent === null ? [row.symbol] : []),
      metadata: { fund: data.fund, asOf: data.asOf, snapshotAsOf: data.snapshotAsOf, aggregate: data.aggregate, stale: data.stale } };
  },
};
