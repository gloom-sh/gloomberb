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
  type PortfolioRiskModel,
  type RiskDisplayRow,
  type RiskView,
} from "./risk-model";

const RISK_COLUMNS = [
  { key: "label", header: "Metric" },
  { key: "value", header: "Value", align: "right" as const },
  { key: "percentile", header: "Pctl 1Y", align: "right" as const },
  { key: "asOf", header: "As of" },
  { key: "detail", header: "Evidence" },
];

/** Rows of one view in the compact result; the pane and reports keep every row. */
const COMPACT_ROW_LIMIT = 100;
/** The correlation view is every pair of holdings; the compact result keeps the strongest. */
const COMPACT_PAIR_LIMIT = 25;

/** Formatted like the pane; metadata.model keeps full precision. */
function displayRow(row: RiskDisplayRow) {
  return {
    label: row.label,
    value: riskValue(row),
    percentile: riskPercentile(row),
    asOf: row.asOf?.slice(0, 10) ?? null,
    detail: row.detail,
  };
}

function isRiskView(value: unknown): value is RiskView {
  return typeof value === "string" && (RISK_VIEWS as readonly string[]).includes(value);
}

/** One view, its strongest or first rows, and the portfolio's totals instead of the model. */
function compactRiskRows(model: PortfolioRiskModel, view: RiskView): { rows: RiskDisplayRow[]; notices: string[] } {
  const all = model.rows[view];
  if (view === "correlation") {
    const rows = all
      .filter((row) => row.value != null && Number.isFinite(row.value))
      .sort((left, right) => Math.abs(right.value!) - Math.abs(left.value!))
      .slice(0, COMPACT_PAIR_LIMIT);
    return {
      rows,
      notices: all.length > rows.length
        ? [`Strongest ${rows.length} of ${all.length} pairs by absolute correlation.`]
        : [],
    };
  }
  if (all.length <= COMPACT_ROW_LIMIT) return { rows: all, notices: [] };
  return {
    rows: all.slice(0, COMPACT_ROW_LIMIT),
    notices: [`${all.length - COMPACT_ROW_LIMIT} more ${view} rows not shown.`],
  };
}

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
            new Date(),
            ctx.signal,
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
        columns: RISK_COLUMNS,
        rows: model.rows[view].map(displayRow),
      })),
      metadata: { model },
    };
  },
  compact(result, args) {
    const model = result.metadata?.model as PortfolioRiskModel | undefined;
    if (!model?.rows) return result;
    const view = isRiskView(args.options.view) ? args.options.view : "risk";
    const { rows, notices } = compactRiskRows(model, view);
    const valued = model.holdings.filter((holding) => holding.value != null).length;
    return {
      complete: result.complete,
      ...(result.errors?.length ? { errors: result.errors } : {}),
      sections: [{ title: view, columns: RISK_COLUMNS, rows: rows.map(displayRow) }],
      metadata: {
        portfolio: {
          id: model.portfolio.id,
          name: model.portfolio.name,
          currency: model.portfolio.currency,
        },
        view,
        holdings: model.holdings.length,
        valuedHoldings: valued,
        ...(model.book ? { grossValue: model.book.gross, netValue: model.book.net } : {}),
        asOf: model.fetchedAt,
        ...(notices.length ? { notices } : {}),
      },
    };
  },
};
