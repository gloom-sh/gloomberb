import { describe, expect, test } from "bun:test";
import { congressHeadless } from "../../plugins/builtin/congress-trades/headless";
import { holdersHeadless } from "../../plugins/builtin/holders/headless";
import { insiderHeadless } from "../../plugins/builtin/insider/headless";
import { mnaHeadless } from "../../plugins/builtin/mna/headless";
import { riskFactorsHeadless } from "../../plugins/builtin/risk-factors/headless";
import { thirteenFHeadless } from "../../plugins/builtin/thirteenf/headless";
import type { HeadlessPaneDefinition } from "../../types/headless";
import type { PaneFunctionCapability } from "./capabilities";
import { shotOptionRefusal } from "./shot-options";

const thirteenF = { token: "13F", capability: { options: thirteenFHeadless.options } as PaneFunctionCapability };

describe("shot options", () => {
  test("refuses an option only the report reads, naming the report that reads it, and a slip of an option's name", () => {
    expect(shotOptionRefusal(thirteenF, "0001067983", { limit: "5" })).toBe(
      "13F's pane does not draw --limit: it sets how many rows the text report prints. Drop it from shot, or run the report: gloom fn 13F 0001067983 --limit 5",
    );
    expect(shotOptionRefusal(thirteenF, "Berkshire Hathaway", { count: "5" })).toContain("gloom fn 13F \"Berkshire Hathaway\" --limit 5");
    expect(shotOptionRefusal(thirteenF, "0001067983", { veiw: "overlap" })).toBe("13F has no --veiw. Did you mean --view?");
  });

  test("refuses the CLI's row and report-text options a pane does not draw", () => {
    const chart = { token: "HP", capability: { options: [{ key: "range", type: "string" }] } as unknown as PaneFunctionCapability };
    // fn HP refuses --tail too, so there is no report to point to.
    expect(shotOptionRefusal(chart, "AAPL", { tail: "5" })).toBe(
      "HP has no --tail: it keeps a printed table's newest rows, and neither HP's pane nor its report has one. Drop it from shot.",
    );
    expect(shotOptionRefusal(chart, "AAPL", { limit: "5" })).toContain("HP has no --limit: it cuts a printed table to its first rows");
    expect(shotOptionRefusal(chart, "AAPL", {}, { explain: true })).toBe(
      "shot saves no report text, and --explain follows a report's text with the terms it shows. Drop it from shot, or run the report: gloom fn HP AAPL --explain",
    );
    expect(shotOptionRefusal(chart, "AAPL", { section: "2" })).toContain("run the report: gloom fn HP AAPL --csv --section 2");
    // A function's own option of that name is read as the option.
    const calls = { token: "CALLS", capability: { options: [{ key: "section", type: "string", shot: { reportOnly: "picks a transcript section for the text report" } }] } as unknown as PaneFunctionCapability };
    expect(shotOptionRefusal(calls, "NVDA", { section: "qa" })).toContain("CALLS's pane does not draw --section: it picks a transcript section");
  });

  test("passes the options the pane draws and the pane settings a capture takes", () => {
    expect(shotOptionRefusal(thirteenF, "0001067983", { view: "overlap", compare: "SPY" })).toBeNull();
    expect(shotOptionRefusal(thirteenF, "0001067983", { tab: "filings", "state.detailTab": "filings", initialCik: "0001067983" })).toBeNull();
  });

  test("the filters a pane keeps open it as asked, only when asked, under the keys the pane reads", () => {
    const open = (headless: HeadlessPaneDefinition, symbols: string[], options: Record<string, string | number | boolean>, given: string[] = Object.keys(options)) =>
      headless.shotState!({ rawArgument: symbols.join(","), argument: symbols[0] ?? null, symbols, options }, async () => { throw new Error("not loaded"); }, new Set(given));
    // M&A of one company keeps its status apart, and its default (every status) stands unless one is asked for.
    expect(open(mnaHeadless, [], { status: "completed", target: "public", region: "us" }, ["status", "region"]))
      .toEqual({ pluginState: { "ticker-research": { status: "completed", region: "us" } } });
    expect(open(mnaHeadless, ["AAPL"], { status: "pending" })).toEqual({ pluginState: { "ticker-research": { "ticker.status": "pending" } } });
    expect(open(mnaHeadless, ["AAPL"], { status: "pending" }, [])).toEqual({});
    expect(() => open(mnaHeadless, ["AAPL"], { target: "private" })).toThrow("One company's deals have no --target filter.");
    // INS filters a company's trades by insider, kept by ticker; it has no trades to filter without one.
    expect(open(insiderHeadless, ["AAPL"], { name: "COOK TIMOTHY D", view: "trades" }, ["name"]))
      .toEqual({ pluginState: { "ticker-research": { "insider:nameFilter:AAPL": "COOK TIMOTHY D" } } });
    expect(() => open(insiderHeadless, [], { name: "COOK TIMOTHY D" })).toThrow("--name filters one company's trades");
    // CG's filter bar, "all" and a zero minimum being no filter; a ticker's pane keeps its own.
    expect(open(congressHeadless, [], { tab: "trades", chamber: "senate", side: "all", minAmount: 50001 }, ["chamber", "side", "minAmount"]))
      .toEqual({ pluginState: { "gloomberb-cloud": { filters: { chamber: "senate", minAmount: 50001 } } } });
    expect(open(congressHeadless, ["NVDA"], { tab: "trades", owner: "spouse" }, ["owner"]))
      .toEqual({ pluginState: { "gloomberb-cloud": { "congressTicker.filters": { owner: "spouse" } } } });
    // HDS sorts its table, or its 13D/13G list on that view, as the report does.
    expect(open(holdersHeadless, ["AAPL"], { sort: "change", order: "asc", view: "table" }))
      .toEqual({ pluginState: { "ticker-research": { sortPreference: { columnId: "changeShares", direction: "asc" } } } });
    expect(open(holdersHeadless, ["AAPL"], { sort: "date", order: "desc", view: "13dg" }, ["sort"]))
      .toEqual({ pluginState: { "ticker-research": { beneficialSort: { columnId: "filingDate", direction: "desc" } } } });
    // RISK opens on the year asked for; latest follows the newest filing.
    expect(open(riskFactorsHeadless, ["AAPL"], { year: "2024" })).toEqual({ pluginState: { "ticker-research": { filingYear: 2024 } } });
    expect(open(riskFactorsHeadless, ["AAPL"], { year: "latest" })).toEqual({ pluginState: { "ticker-research": { filingYear: null } } });
  });
});
