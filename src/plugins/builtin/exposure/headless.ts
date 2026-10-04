import type { HeadlessPaneDefinition } from "../../../types/plugin";
import type { ExposureRequest } from "../../../api-client/exposure";
import { fetchExposure, fetchScenarios } from "./client";
import { DEFAULT_SCENARIO, parseCustomScenario, parseHoldings, TABS } from "./model";
import { portfolioHoldings, watchlistHoldings } from "./holdings";

export const exposureHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "free-text", optional: true, placeholder: "AAPL=60% NVDA=40%", description: "Tickers, signed NAV weights, PORT:<id>, or WATCH:<id>. Unweighted lists and watchlists use equal weights." },
  discovery: { aliases: ["EXPO"], dataRequirements: ["Gloom Cloud geographic revenue and disclosed supply chains", "Portfolio NAV for local PORT weights"],
    limitations: ["Pro: full holdings and up to four-hop paths; free: one holding, one hop", "Operating exposure estimates, never predicted stock returns", "Missing relationships and sensitivities remain unknown", "Basis and reporting period are kept separate"] },
  options: [
    { key: "scenario", type: "string", settingKey: "scenario", defaultValue: "taiwan-disruption", description: "Library scenario id, or use --custom." },
    { key: "custom", type: "string", settingKey: "customScenario", description: "JSON scenario with label and shocks; supports multiple shocks and explicit transmission assumptions." },
    { key: "depth", type: "integer", settingKey: "depth", defaultValue: 2, minimum: 1, maximum: 4, description: "Maximum relationship hops." },
    { key: "nav", type: "string", settingKey: "nav", description: "Positive portfolio NAV in its configured currency; required for PORT." },
    { key: "cash", type: "string", settingKey: "cash", description: "Explicit cash weight as NAV fraction; no normalization." },
    { key: "tab", type: "enum", settingKey: "tab", defaultValue: "table", values: TABS.map(t => ({ value: t.value })), description: "Pane tab." },
    { key: "view", type: "enum", settingKey: "view", defaultValue: "stress", values: ["stress", "country", "supplier", "customer"].map(value => ({ value })), description: "Portfolio stress or concentration grouping." },
  ],
  describe: args => `Exposure | ${args.rawArgument || "holdings"}`,
  async load(args, ctx) {
    const input = args.rawArgument.trim();
    const source = /^(PORT|WATCH):(.+)$/i.exec(input);
    let holdings: ExposureRequest["holdings"];
    if (source?.[1]?.toUpperCase() === "PORT") {
      const local = await ctx.resolvePortfolio?.(source[2]!);
      if (!local) throw new Error(`Unknown local portfolio: ${source[2]}`);
      holdings = await portfolioHoldings(local.portfolio, local.tickers, Number(args.options.nav), ctx.marketData);
    } else if (source) {
      const tickers = await ctx.resolveWatchlist?.(source[2]!);
      if (!tickers) throw new Error(`Unknown local watchlist: ${source[2]}`);
      holdings = watchlistHoldings(tickers, source[2]!);
    } else holdings = parseHoldings(input);
    const id = String(args.options.scenario ?? DEFAULT_SCENARIO.id);
    const scenario = args.options.custom ? parseCustomScenario(String(args.options.custom)) : (await fetchScenarios(ctx.apiClient)).find(s => s.id === id);
    if (!scenario) throw new Error(`Unknown scenario: ${id}`);
    const cashWeight = args.options.cash === undefined ? undefined : Number(args.options.cash);
    if (cashWeight !== undefined && (!Number.isFinite(cashWeight) || Math.abs(cashWeight) > 10)) throw new Error("Cash must be a NAV fraction between -10 and 10.");
    if (ctx.signal.aborted) throw new Error("Exposure analysis cancelled.");
    const data = await fetchExposure({ holdings, scenario, depth: Number(args.options.depth ?? 2), ...(cashWeight === undefined ? {} : { cashWeight }) }, ctx.apiClient);
    return { complete: data.lockedHoldings === 0 && data.holdings.every(h => h.status === "quantified") && data.unknowns.length === 0,
      errors: [...data.unknowns, ...(data.access === "preview" ? ["Free preview: one holding, depth one. Full analysis requires Pro."] : [])],
      sections: [
        { title: "Holdings", rows: data.holdings.map(h => ({ symbol: h.symbol, weight: h.weight, status: h.status, measures: h.measures, coverage: h.coverage, unknowns: h.unknowns })) },
        { title: "Paths and evidence", rows: data.holdings.flatMap(h => h.components.map(c => ({ symbol: h.symbol, ...c }))) },
        { title: "Portfolio operating stress", rows: data.portfolio.measures.map(m => ({ ...m })) },
        { title: "Concentrations", rows: data.portfolio.concentrations.map(c => ({ ...c })) },
      ], metadata: { payload: data } };
  },
};
