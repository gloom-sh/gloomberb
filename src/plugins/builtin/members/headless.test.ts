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
  expect(await line("realtime", "2026-10-24T14:00:00Z")).toBe("Source: Gloom Cloud · US trading day Fri 23 Oct 2026 close · markets closed until Mon");
  expect(await line("delayed", "2026-10-24T14:00:00Z")).toContain("15 min delayed");
});
