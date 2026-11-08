import { afterEach, expect, setSystemTime, test } from "bun:test";
import { deriveHeadlessFreshness, formatFreshnessLine } from "../../../cli/pane-functions/freshness";
import { applyListingArgument, resolvePaneFunction } from "../../../cli/pane-functions/resolver";
import { parsePaneFunctionArgs } from "../../../cli/pane-functions/options";
import type { PaneFunctionCatalog } from "../../../cli/pane-functions/catalog";
import type { MarketContext } from "../../../cli/types";
import { createDefaultConfig } from "../../../types/config";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs, HeadlessRowsResult } from "../../../types/headless";
import { membersHeadless } from "./headless";
import { membersPlugin } from "./index";
import { canonicalFund } from "./model";
import { board } from "./test-fixture";

afterEach(() => setSystemTime());

test("MEMB index arguments reach the fund service without requiring a stock quote", async () => {
  const registry: PaneFunctionCatalog = {
    panes: new Map(membersPlugin.panes!.map(pane => [pane.id, pane])),
    paneTemplates: new Map(membersPlugin.paneTemplates!.map(template => [template.id, template])), destroy() {},
  };
  const context = { config: createDefaultConfig(":memory:"), dataProvider: new Proxy({}, { get() { throw new Error("An index alias must not resolve as a stock"); } }) } as MarketContext;
  for (const [alias, fund] of Object.entries({ SPX: "IVV", "^SPX": "IVV", "^GSPC": "IVV", "^MID": "IJH", "^SML": "IJR", "^RUT": "IWM", "^RUI": "IWB" })) {
    const args = await applyListingArgument(registry, context, parsePaneFunctionArgs(["MEMB", alias, "--tab", "breadth"]));
    const resolved = await resolvePaneFunction(registry, context, args, { strictHeadlessOptions: true });
    expect(resolved.instance.binding).toMatchObject({ kind: "fixed", symbol: alias });
    expect(resolved.options.tab).toBe("breadth");
    expect(canonicalFund(alias)).toBe(fund);
  }
  // Bare listings must not be redirected to an unrelated tracking fund.
  for (const ticker of ["MID", "SML"]) expect(canonicalFund(ticker)).toBe(ticker);
});

test("a Pro account's report is live only while a session trades, and as of the close otherwise", async () => {
  const line = async (access: "realtime" | "delayed", at: string) => {
    setSystemTime(new Date(at));
    const quoted = { ...board, access, members: board.members.map((row) => ({ ...row, dailyAsOf: "2026-10-23T19:50:00Z", priceAsOf: "2026-10-23T19:50:00Z" })) };
    const args = { symbols: ["SPY"], argument: ["SPY"], rawArgument: "SPY", options: {} } as unknown as HeadlessPaneLoadArgs;
    const result = await membersHeadless.load(args, { signal: new AbortController().signal, apiClient: { getFundMembers: async () => quoted }, refresh: false } as unknown as HeadlessPaneContext) as HeadlessRowsResult;
    return formatFreshnessLine(deriveHeadlessFreshness(membersHeadless, result, Date.now()));
  };
  expect(await line("realtime", "2026-10-23T19:55:00Z")).toBe("Source: Gloom Cloud · Fri 23 Oct 2026 19:50 UTC · live");
  expect(await line("realtime", "2026-10-24T14:00:00Z")).toBe("Source: Gloom Cloud · US trading day Fri 23 Oct 2026 close · markets closed · regular session opens Mon 13:30 UTC, 09:30 ET");
  expect(await line("delayed", "2026-10-24T14:00:00Z")).toContain("15 min delayed");
});

test("an empty changes table says why: the fund's index changes are not covered, or none is stored", async () => {
  const load = async (available: boolean) => {
    const changes = { fund: { ticker: "XLK", name: "Technology", aliases: [], changes: available ? "announcements" : "none" }, changes: [], asOf: null, stale: false, available,
      estimateLabel: "Estimate from XLK share counts", attribution: null };
    const args = { symbols: ["XLK"], argument: ["XLK"], rawArgument: "XLK", options: { tab: "changes" } } as unknown as HeadlessPaneLoadArgs;
    return (await membersHeadless.load(args, { signal: new AbortController().signal, apiClient: { getFundChanges: async () => changes }, refresh: false } as unknown as HeadlessPaneContext) as HeadlessRowsResult).empty;
  };
  expect(await load(false)).toBe("Index changes are not covered for XLK.");
  expect(await load(true)).toBe("No stored index changes.");
});

test("a stock lists the covered funds holding it; an N-PORT fund's holdings say their report date and filing day, never today", async () => {
  const funds = { funds: [{ ticker: "IVV", name: "S&P 500", aliases: ["SPY"], changes: "sp500", basis: "daily", asOf: "2026-11-05", filedOn: null },
    { ticker: "ARKK", name: "Disruptive innovation (N-PORT)", plainName: "Disruptive innovation", aliases: [], changes: "none", basis: "nport", asOf: "2026-07-31", filedOn: "2026-09-22" }] };
  const report = "https://www.sec.gov/Archives/edgar/data/1579982/000157998226000001/primary_doc.xml";
  const held = { symbol: "NVDA", coverage: { daily: 1, nport: 1 }, funds: [
    { ticker: "IVV", name: "S&P 500", basis: "daily", weight: 0.0712, shares: 1, marketValue: 1, holdingName: "NVIDIA CORP", asOf: "2026-11-05", filedOn: null },
    { ticker: "ARKK", name: "Disruptive innovation", basis: "nport", weight: 0.037, shares: 1, marketValue: 1, holdingName: "NVIDIA CORP", asOf: "2026-07-31", filedOn: "2026-09-22", sourceUrl: report }] };
  const asked: string[] = [];
  const apiClient = { getMemberFunds: async () => funds, getStockFunds: async (symbol: string) => { asked.push(symbol); return held; },
    getFundMembers: async () => ({ ...board, fund: funds.funds[1], basis: "nport", asOf: "2026-07-31", filedOn: "2026-09-22", sourceUrl: report, excludedShorts: 2 }) };
  const load = async (input: string) => await membersHeadless.load({ symbols: [input], argument: [input], rawArgument: input, options: {} } as unknown as HeadlessPaneLoadArgs,
    { signal: new AbortController().signal, apiClient, refresh: false } as unknown as HeadlessPaneContext) as HeadlessRowsResult;
  const stock = await load("NVDA");
  expect(stock.rows.map((row) => [row.ticker, Number((row.weight as number).toFixed(2)), row.asOf, row.source])).toEqual([
    ["IVV", 7.12, "2026-11-05", "Daily file"], ["ARKK", 3.7, "2026-07-31", "N-PORT, filed 22 Sep 2026"]]);
  // A listing abroad is not looked up by its local code.
  expect((await load("INFY:NSE")).empty).toContain("US ticker");
  expect(asked).toEqual(["NVDA"]);
  // An exported row read alone still says what the holdings are as of: the fund's report date, filing day and link.
  expect(stock.rows[1]).toMatchObject({ filedOn: "2026-09-22", sourceUrl: report });
  expect(stock.columns!.map((column) => column.key)).toEqual(expect.arrayContaining(["filedOn", "sourceUrl"]));
  const arkk = await load("ARKK");
  const notices = (arkk.metadata as { notices: string[] }).notices;
  expect(notices[0]).toBe("Disruptive innovation, ARKK holdings as of 31 Jul 2026 (N-PORT, filed 22 Sep)");
  // Shorts are named apart from derivatives.
  expect(notices).toContain("2 short positions are excluded from these share holdings.");
  expect(arkk.rows.every((row) => row.holdingsAsOf === "2026-07-31" && row.filedOn === "2026-09-22" && row.sourceUrl === report)).toBe(true);
  expect(arkk.columns!.slice(-3).map((column) => [column.key, column.minTableWidth])).toEqual([
    ["holdingsAsOf", Number.MAX_SAFE_INTEGER], ["filedOn", Number.MAX_SAFE_INTEGER], ["sourceUrl", Number.MAX_SAFE_INTEGER]]);
  // The list names the fund as it is, its basis in its own column.
  const list = await load("");
  expect(list.rows.find((row) => row.ticker === "ARKK")).toMatchObject({ name: "Disruptive innovation", source: "N-PORT, filed 22 Sep 2026" });
});
