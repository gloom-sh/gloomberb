import { loadPortfolioOptionBook } from "./risk-options";
import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchPortfolioRiskMarket } from "./risk-client";
import { parsePortfolioRiskEvidence } from "./risk-evidence";
import {
  buildPortfolioRisk,
  portfolioRiskTickers,
  RISK_VIEWS,
  riskPercentile,
  riskValue,
} from "./risk-model";

export const portfolioRiskHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  argument: {
    kind: "free-text",
    optional: true,
    placeholder: "portfolio-id",
    description:
      "Local portfolio ID. Defaults to the first configured portfolio.",
  },
  discovery: {
    aliases: ["PORT", "MARS"],
    dataRequirements: [
      "Local holdings; Gloom Cloud daily prices and FRED",
      "Explicit local evidence for account returns and attribution",
    ],
    limitations: [
      "Fixed-current-weight USD equity basket; no account performance inferred",
      "ETF price-return factor proxies",
      "Historical percentiles need 20 rolling samples",
    ],
  },
  options: [
    {
      key: "view",
      type: "enum",
      settingKey: "riskView",
      defaultValue: "risk",
      values: RISK_VIEWS.map((value) => ({ value })),
      description: "Portfolio risk view.",
    },
    {
      key: "evidence",
      type: "string",
      settingKey: "riskEvidence",
      description: "Version 1 local account-evidence JSON.",
    },
    {
      key: "equity-shift",
      type: "integer",
      settingKey: "equityShift",
      defaultValue: -10,
      minimum: -99,
      maximum: 100,
      description: "Independent index shock in percent.",
    },
    {
      key: "rate-shift",
      type: "integer",
      settingKey: "rateShift",
      defaultValue: 100,
      minimum: -500,
      maximum: 500,
      description: "Independent 10Y yield shock in basis points.",
    },
    {
      key: "vol-shift",
      type: "integer",
      settingKey: "volShift",
      defaultValue: 10,
      minimum: -50,
      maximum: 100,
      description: "Independent VIX shock in index points.",
    },
  ],
  describe: (args) =>
    `Portfolio risk | ${args.rawArgument || "local portfolio"}`,
  async load(args, ctx) {
    const id = args.rawArgument.trim() || ctx.config.portfolios[0]?.id;
    if (!id || !ctx.resolvePortfolio)
      throw new Error("A local portfolio is required");
    const local = await ctx.resolvePortfolio(id);
    if (!local) throw new Error(`Unknown local portfolio: ${id}`);
    const tickers = portfolioRiskTickers(local.tickers, id);
    const evidence = parsePortfolioRiskEvidence(
      String(args.options.evidence ?? ctx.settings?.riskEvidence ?? ""),
    );
    if (
      evidence &&
      (evidence.portfolioId !== id ||
        evidence.currency !== local.portfolio.currency)
    )
      throw new Error(
        "Imported evidence belongs to a different portfolio or currency",
      );
    const view = String(args.options.view ?? "risk");
    const localOnly =
      ["performance", "attribution", "greeks"].includes(view) &&
      evidence != null;
    const [prices, brokerOptions] = await Promise.all([
      localOnly
        ? Promise.resolve({
            histories: [],
            yields: null,
            volatility: null,
            warnings: [],
            fetchedAt: new Date().toISOString(),
          })
        : fetchPortfolioRiskMarket(
            tickers
              .slice(0, 80)
              .map((row) => ({
                symbol: row.metadata.ticker,
                exchange: row.metadata.exchange,
              })),
            ctx.apiClient,
          ),
      localOnly
        ? Promise.resolve(undefined)
        : loadPortfolioOptionBook(tickers, local.portfolio),
    ]);
    const market = { ...prices, brokerOptions };
    if (ctx.signal.aborted) throw new Error("Portfolio risk load cancelled");
    const model = buildPortfolioRisk(
      local.portfolio,
      tickers,
      market,
      evidence,
      {
        equity: Number(args.options["equity-shift"] ?? -10),
        rates: Number(args.options["rate-shift"] ?? 100),
        volatility: Number(args.options["vol-shift"] ?? 10),
      },
    );
    const complete =
      view === "performance"
        ? model.performance != null
        : view === "attribution"
          ? model.attribution != null
          : view === "greeks"
            ? model.greeks?.complete === true
            : view === "holdings"
              ? model.book != null
              : view === "factors"
                ? model.factors.every((row) => row.value != null)
                : model.complete;
    return {
      complete,
      errors: model.warnings,
      sections: RISK_VIEWS.map((view) => ({
        title: view,
        columns: [
          { key: "label", header: "Metric" },
          { key: "value", header: "Value", align: "right" as const },
          { key: "percentile", header: "Pctl 1Y", align: "right" as const },
          { key: "asOf", header: "As of" },
          { key: "detail", header: "Evidence" },
        ],
        // Formatted like the pane; metadata.model keeps full precision.
        rows: model.rows[view].map((row) => ({
          label: row.label,
          value: riskValue(row),
          percentile: riskPercentile(row),
          asOf: row.asOf?.slice(0, 10) ?? null,
          detail: row.detail,
        })),
      })),
      metadata: { model },
    };
  },
};
