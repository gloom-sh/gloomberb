import { loadPortfolioOptionBook } from "./risk-options";
import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchPortfolioRiskMarket, RISK_HISTORY_LIMIT } from "./risk-client";
import { parsePortfolioRiskEvidence } from "./risk-evidence";
import {
  BASKET_VIEWS,
  buildPortfolioRisk,
  portfolioRiskRequests,
  portfolioRiskTickers,
  riskCoverageNotices,
  riskCoverageShortfall,
  riskCoverageText,
  RISK_VIEWS,
  riskPercentile,
  riskValue,
  type PortfolioRiskModel,
  type RiskCoverage,
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

/** Left-out holdings listed in the compact result; the full report lists every one. */
const COMPACT_LEFT_OUT_LIMIT = 40;

/** What the basket views cover, so a report never reads as the whole account when it is not. */
function coverageSummary(coverage: RiskCoverage, limit = Infinity) {
  return {
    share: coverage.share,
    shareIsUpperBound: coverage.unvalued > 0,
    minimumShare: coverage.minimumShare,
    estimated: coverage.sufficient,
    currency: coverage.currency,
    marketValue: coverage.marketValue,
    coveredValue: coverage.coveredValue,
    holdings: coverage.holdings,
    covered: coverage.covered,
    leftOut: coverage.leftOut
      .slice(0, limit)
      .map((row) => ({ symbol: row.symbol, reason: row.reason, share: row.share })),
    ...(coverage.leftOut.length > limit ? { moreLeftOut: coverage.leftOut.length - limit } : {}),
  };
}

/** One line for the whole coverage in place of a notice per left-out holding. */
function coverageError(coverage: RiskCoverage | undefined): string | null {
  const shortfall = riskCoverageShortfall(coverage);
  if (shortfall) return `Basket estimates unavailable: ${shortfall.title} ${shortfall.message}`.trim();
  const text = riskCoverageText(coverage);
  return text ? `Basket ${text}; metadata.coverage lists each with its reason.` : null;
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
  freshness: { source: "Local portfolio and Gloom Cloud", status: "not-a-feed", basis: "risk model on daily closes" },
  argument: {
    kind: "free-text",
    optional: true,
    placeholder: "portfolio-id",
    // Not "Defaults to the first portfolio": Gloom read that as an id and sent "default".
    description: "Portfolio ID exactly as configured. Leave it out to use the first portfolio.",
  },
  discovery: {
    aliases: ["PORT", "MARS"],
    dataRequirements: [
      "Local holdings; Gloom Cloud daily prices and FRED",
      "Explicit local evidence for account returns and attribution",
    ],
    limitations: [
      `Fixed-current-weight USD equity basket over the holdings that qualify, largest ${RISK_HISTORY_LIMIT} by value; metadata.coverage states the covered share of market value and each holding left out`,
      "No account performance inferred",
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
    if (!local) {
      const ids = ctx.config.portfolios.map((portfolio) => portfolio.id);
      throw new Error(`Unknown local portfolio: ${id}.${ids.length ? ` Portfolio IDs: ${ids.slice(0, 12).join(", ")}${ids.length > 12 ? ` and ${ids.length - 12} more` : ""}.` : ""}`);
    }
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
            portfolioRiskRequests(tickers, id),
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
    // A basket view is complete only when the basket covers every holding.
    const covered = model.coverage.leftOut.length === 0;
    const complete =
      view === "performance"
        ? model.performance != null
        : view === "attribution"
          ? model.attribution != null
          : view === "greeks"
            ? model.greeks?.complete === true
            : view === "holdings"
              ? model.book != null && covered
              : view === "factors"
                ? covered && model.factors.every((row) => row.value != null)
                : model.complete;
    return {
      complete,
      errors: [...riskCoverageNotices(model.coverage), ...model.warnings],
      sections: RISK_VIEWS.map((view) => ({
        title: view,
        columns: RISK_COLUMNS,
        rows: model.rows[view].map(displayRow),
      })),
      metadata: { coverage: coverageSummary(model.coverage), model },
    };
  },
  compact(result, args) {
    const model = result.metadata?.model as PortfolioRiskModel | undefined;
    if (!model?.rows) return result;
    const view = isRiskView(args.options.view) ? args.options.view : "risk";
    const { rows, notices } = compactRiskRows(model, view);
    // Each left-out holding is in metadata.coverage; the errors keep one line for all of them.
    const perHolding = new Set(riskCoverageNotices(model.coverage));
    const basketView = BASKET_VIEWS.has(view);
    const coverageLine = basketView ? coverageError(model.coverage) : null;
    const errors = [
      ...(coverageLine ? [coverageLine] : []),
      ...(result.errors ?? []).filter((error) => !perHolding.has(error)),
    ];
    return {
      complete: result.complete,
      ...(errors.length ? { errors } : {}),
      sections: [{ title: view, columns: RISK_COLUMNS, rows: rows.map(displayRow) }],
      metadata: {
        portfolio: {
          id: model.portfolio.id,
          name: model.portfolio.name,
          currency: model.portfolio.currency,
        },
        view,
        ...(basketView && model.coverage
          ? { coverage: coverageSummary(model.coverage, COMPACT_LEFT_OUT_LIMIT) }
          : {}),
        asOf: model.fetchedAt,
        ...(notices.length ? { notices } : {}),
      },
    };
  },
};
