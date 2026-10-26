import { loadPortfolioOptionBook } from "./risk-options";
import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchPortfolioRiskMarket, RISK_HISTORY_LIMIT } from "./risk-client";
import { parsePortfolioRiskEvidence } from "./risk-evidence";
import { describeCollections } from "../../../portfolio/collection-name";
import { shellWord } from "../../../utils/shell-word";
import { formatShocks, parseAssetShifts, parseFxShifts, riskCashLines } from "./risk-book";
import {
  BASKET_VIEWS,
  BOOK_TOTAL_ROW_ID,
  buildPortfolioRisk,
  portfolioRiskRequests,
  portfolioRiskTickers,
  riskCoverageLine,
  riskCoverageNotices,
  riskCoverageShortfall,
  riskHoldingsLeftOut,
  RISK_VIEWS,
  riskEvidence,
  riskPercentile,
  riskReturnsCurrency,
  riskValue,
  sinceFallbackNote,
  sinceFiledMethod,
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

/** The error for a portfolio argument nothing matches: the names and ids there are, so the next call can use one. */
function unknownPortfolio(raw: string, portfolios: readonly { id: string; name: string }[]): string {
  return `Unknown local portfolio: ${raw}.${portfolios.length ? ` Portfolios: ${describeCollections(portfolios)}.` : ""}`;
}

/** The portfolio's name in a full result (its model) or a compact one. */
function reportPortfolioName(metadata: Record<string, unknown> | undefined): string | undefined {
  const model = metadata?.model as Partial<PortfolioRiskModel> | undefined;
  const compact = metadata?.portfolio as { name?: unknown } | undefined;
  const name = model?.portfolio?.name ?? compact?.name;
  return typeof name === "string" ? name : undefined;
}

/**
 * What a portfolio with nothing to estimate says, as one line: the commands
 * that fill it. Risk is read from lots, so a symbol listed without shares
 * (`portfolio add`) is no holding yet; `portfolio position set` gives it
 * shares, and adds the symbol too when it is not listed.
 */
function emptyPortfolioHint(name: string, listed: readonly string[]): string {
  const portfolio = shellWord(name);
  if (listed.length > 0) {
    return `${name} lists ${listed.slice(0, 3).join(", ")}${listed.length > 3 ? ` and ${listed.length - 3} more` : ""} but holds no shares: `
      + `gloom portfolio position set ${portfolio} ${shellWord(listed[0]!)} 10 150.`;
  }
  return `No holdings in ${name}. Add symbols with gloom portfolio add ${portfolio} AAPL,MSFT, `
    + `then their shares with gloom portfolio position set ${portfolio} AAPL 10 150.`;
}

/** Rows of one view in the compact result; the pane and reports keep every row. */
const COMPACT_ROW_LIMIT = 100;
/** The correlation view is every pair of holdings; the compact result keeps the strongest. */
const COMPACT_PAIR_LIMIT = 25;

/**
 * Formatted like the pane; metadata.model keeps full precision. A tail loss in
 * money is of the covered basket, so its evidence names how it is estimated,
 * the basket's share of the book and what it leaves out, as the pane's footer
 * does beside the same figure.
 */
function displayRow(row: RiskDisplayRow) {
  return {
    label: row.label,
    value: riskValue(row),
    percentile: riskPercentile(row),
    asOf: row.asOf?.slice(0, 10) ?? null,
    detail: riskEvidence(row),
    ...(row.amount != null ? { amount: row.amount, currency: row.amountCurrency ?? null } : {}),
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
    // Of the book, cash included; the minimum is of the holdings' value.
    share: coverage.share,
    shareIsUpperBound: coverage.unvalued > 0,
    holdingsShare: coverage.holdingsShare ?? coverage.share,
    minimumShare: coverage.minimumShare,
    estimated: coverage.sufficient,
    currency: coverage.currency,
    marketValue: coverage.marketValue,
    cashValue: coverage.cashValue ?? 0,
    coveredValue: coverage.coveredValue,
    holdings: coverage.holdings,
    covered: coverage.covered,
    convertedFromLocalCurrency: coverage.converted,
    leftOut: coverage.leftOut
      .slice(0, limit)
      .map((row) => ({ symbol: row.symbol, reason: row.reason, share: row.share, ...(row.cash ? { cash: true } : {}) })),
    ...(coverage.leftOut.length > limit ? { moreLeftOut: coverage.leftOut.length - limit } : {}),
  };
}

/** One line for the whole coverage in place of a note per left-out holding. */
function coverageLine(coverage: RiskCoverage | undefined): { error?: string; note?: string } {
  const shortfall = riskCoverageShortfall(coverage);
  // No estimate at all is a failure; an estimate that leaves holdings out is a caveat.
  if (shortfall) return { error: `Basket estimates unavailable: ${shortfall.title} ${shortfall.message}`.trim() };
  const line = coverage?.leftOut.length ? riskCoverageLine(coverage) : null;
  return line ? { note: `${line[0]!.toUpperCase()}${line.slice(1)}; metadata.coverage lists each with its reason.` } : {};
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
  // The book's total of the shocks is what they come to: the lines go before it does.
  const total = all.filter((row) => row.id === BOOK_TOTAL_ROW_ID);
  const rows = [...all.filter((row) => row.id !== BOOK_TOTAL_ROW_ID).slice(0, COMPACT_ROW_LIMIT - total.length), ...total];
  return {
    rows,
    notices: [`${all.length - rows.length} more ${view} rows not shown.`],
  };
}

export const portfolioRiskHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  freshness: { source: "Local portfolio and Gloom Cloud", status: "not-a-feed", basis: "daily closes" },
  argument: {
    kind: "free-text",
    optional: true,
    placeholder: "portfolio-id",
    // Not "Defaults to the first portfolio": Gloom read that as an id and sent "default".
    description: "Portfolio ID or name, in any case. Leave it out to use the first portfolio.",
  },
  discovery: {
    aliases: ["PORT", "MARS"],
    dataRequirements: [
      "Local holdings; Gloom Cloud daily prices and FRED",
      "Explicit local evidence for account returns and attribution",
    ],
    limitations: [
      `Fixed-current-weight equity basket over the holdings that qualify, largest ${RISK_HISTORY_LIMIT} by value, in the account's currency; foreign listings convert to USD at daily FX closes, and a non-USD account's returns then convert into its currency at its own daily FX closes; metadata.coverage states the covered share of the book (cash included) and each holding and currency's cash left out.`,
      "--since filed buys the 13F's own weights at the filing-date close and holds them (--weights current holds today's weights fixed instead).",
      "--fx-shift and --asset-shift reprice every holding and the cash at once; the index, 10Y and VIX shifts are separate basket regressions.",
      "No account performance inferred.",
      "ETF price-return factor proxies.",
      "Historical percentiles need 20 rolling samples.",
    ],
  },
  options: [
    {
      key: "view",
      type: "enum",
      settingKey: "riskView",
      // No default: left out, the report prints every view.
      values: RISK_VIEWS.map((value) => ({ value })),
      description: "One portfolio risk view; every view when left out.",
    },
    {
      key: "since",
      type: "enum",
      settingKey: "riskSince",
      values: [{ value: "filed" }],
      description: "Risk rows since the 13F filing date of a portfolio made with portfolio import --13f, instead of the trailing 60 sessions.",
    },
    {
      key: "weights",
      type: "enum",
      settingKey: "riskWeights",
      values: [{ value: "13f" }, { value: "current" }],
      description: "With --since filed: 13f (when left out) buys the 13F's own weights at the filing-date close and holds them; current holds today's weights fixed over the same sessions.",
    },
    {
      key: "evidence",
      type: "string",
      settingKey: "riskEvidence",
      // "Version 1 local account-evidence JSON" alone had Gloom send evidence=filed, the value of since.
      description: "A whole local account-evidence JSON document (schema version 1) that the user supplied, read only by the performance, attribution and greeks views. Leave it out otherwise; the 13F window is the since option.",
    },
    {
      key: "equity-shift",
      type: "integer",
      settingKey: "equityShift",
      minimum: -99,
      maximum: 100,
      description: "Independent index shock in percent (-10 when left out).",
    },
    {
      key: "rate-shift",
      type: "integer",
      settingKey: "rateShift",
      minimum: -500,
      maximum: 500,
      description: "Independent 10Y yield shock in basis points (100 when left out).",
    },
    {
      key: "vol-shift",
      type: "integer",
      settingKey: "volShift",
      minimum: -50,
      maximum: 100,
      description: "Independent VIX shock in index points (10 when left out).",
    },
    {
      key: "fx-shift",
      type: "string",
      settingKey: "fxShift",
      valueWords: 2,
      placeholder: "CCY pct",
      example: "--fx-shift TRY -20",
      // "TRY -20" read as the lira's move against USD, not USD's against the lira.
      description: "A currency's move against USD in percent: TRY -20 is the lira 20% weaker. Reprices every holding and the cash in that currency, and in a lira account every other line against it. Several separated by commas: TRY -20, EUR 5.",
      normalize: (value) => formatShocks(parseFxShifts(value)),
    },
    {
      key: "asset-shift",
      type: "string",
      settingKey: "assetShift",
      valueWords: 2,
      placeholder: "SYMBOL pct",
      example: "--asset-shift BTC-USD -30",
      description: "A holding's own price move in percent, in its listing currency: GLD 10, BTC-USD -30. Applied with --fx-shift as one scenario. Several separated by commas.",
      normalize: (value) => formatShocks(parseAssetShifts(value)),
    },
  ],
  // The portfolio as configured, so `Family`, `family` and `FAMILY` head the report alike.
  describe: (args, result) =>
    `Portfolio risk | ${reportPortfolioName(result?.metadata) || args.rawArgument || "local portfolio"}`,
  async load(args, ctx) {
    // The host reads the argument by id or name, in any case; everything after goes by the configured id.
    const requested = args.rawArgument.trim() || ctx.config.portfolios[0]?.id;
    if (!requested || !ctx.resolvePortfolio)
      throw new Error("A local portfolio is required");
    const local = await ctx.resolvePortfolio(requested);
    if (!local) throw new Error(unknownPortfolio(requested, ctx.config.portfolios));
    const id = local.portfolio.id;
    const tickers = portfolioRiskTickers(local.tickers, id);
    // The cash beside the holdings: the broker account's by currency, else the portfolio's own.
    const cash = riskCashLines(local.portfolio, local.account);
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
    // A portfolio with no holdings and no cash has nothing to estimate: say how to fill it, not a table of dashes.
    if (tickers.length === 0 && cash.length === 0 && !evidence) {
      const listed = local.tickers.filter((ticker) => ticker.metadata.portfolios.includes(id)).map((ticker) => ticker.metadata.ticker);
      return {
        sections: [],
        complete: false,
        empty: emptyPortfolioHint(local.portfolio.name, listed),
        metadata: { portfolio: { id, name: local.portfolio.name, currency: local.portfolio.currency } },
      };
    }
    const requestedView = isRiskView(args.options.view) ? args.options.view : null;
    const view: string = requestedView ?? "risk";
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
            local.portfolio.currency,
            cash.map((line) => line.currency),
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
        fx: args.options["fx-shift"] ? parseFxShifts(String(args.options["fx-shift"])) : [],
        assets: args.options["asset-shift"] ? parseAssetShifts(String(args.options["asset-shift"])) : [],
      },
      args.options.since === "filed"
        ? { since: "filed", weights: args.options.weights === "current" ? "current" : "13f" }
        : {},
      cash,
    );
    // Options for views the report does not print are named, not dropped silently; the fallback from --since opens the report.
    const fallback = sinceFallbackNote(local.portfolio);
    const shifted = ["equity-shift", "rate-shift", "vol-shift", "fx-shift", "asset-shift"].filter((key) => args.options[key] != null);
    // A non-USD account's returns were converted, and the basket views say into what.
    const returnsCurrency = riskReturnsCurrency(model);
    const notices = [
      ...(returnsCurrency && (!requestedView || (BASKET_VIEWS.has(requestedView) && requestedView !== "holdings"))
        ? [`${returnsCurrency[0]!.toUpperCase()}${returnsCurrency.slice(1)}.`]
        : []),
      ...(model.window.kind === "since-filed" ? [sinceFiledMethod(model.window, model.benchmark)] : []),
      ...(args.options.since === "filed" && model.window.kind !== "since-filed" ? [fallback] : []),
      ...(requestedView && requestedView !== "stress" && shifted.length ? [`${shifted.map((key) => `--${key}`).join(", ")} change${shifted.length === 1 ? "s" : ""} the stress view only, not --view ${requestedView}`] : []),
      ...(requestedView && args.options.since != null && requestedView !== "risk" ? [`--since changes the risk view only, not --view ${requestedView}`] : []),
      ...(args.options.weights != null && args.options.since !== "filed" ? ["--weights applies with --since filed only"] : []),
    ];
    // A basket view is complete only when the basket covers every holding; cash is never in it.
    const covered = !riskHoldingsLeftOut(model.coverage);
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
    // A basket view with too little covered shows no estimate, and the report says why rather than leaving dashes.
    const shortfall = BASKET_VIEWS.has(view as RiskView) ? coverageLine(model.coverage).error : undefined;
    return {
      complete,
      errors: [...(shortfall ? [shortfall] : []), ...model.warnings],
      notes: [...riskCoverageNotices(model.coverage), ...model.notes.filter((note) => note !== fallback)],
      sections: (requestedView ? [requestedView] : RISK_VIEWS).map((view) => ({
        title: view,
        columns: RISK_COLUMNS,
        rows: model.rows[view].map(displayRow),
      })),
      metadata: { coverage: coverageSummary(model.coverage), model, benchmark: model.benchmark, window: model.window, notices },
    };
  },
  compact(result, args) {
    const model = result.metadata?.model as PortfolioRiskModel | undefined;
    if (!model?.rows) return result;
    const view = isRiskView(args.options.view) ? args.options.view : "risk";
    const { rows, notices } = compactRiskRows(model, view);
    // Each left-out holding is in metadata.coverage; the notes keep one line for all of them.
    const perHolding = new Set(riskCoverageNotices(model.coverage));
    const basketView = BASKET_VIEWS.has(view);
    const coverage = basketView ? coverageLine(model.coverage) : {};
    const errors = [...new Set([...(coverage.error ? [coverage.error] : []), ...(result.errors ?? [])])];
    const notes = [...(coverage.note ? [coverage.note] : []), ...(result.notes ?? []).filter((note) => !perHolding.has(note))];
    return {
      complete: result.complete,
      ...(errors.length ? { errors } : {}),
      ...(notes.length ? { notes } : {}),
      sections: [{ title: view, columns: RISK_COLUMNS, rows: rows.map(displayRow) }],
      metadata: {
        portfolio: {
          id: model.portfolio.id,
          name: model.portfolio.name,
          currency: model.portfolio.currency,
        },
        view,
        benchmark: model.benchmark,
        window: model.window,
        ...(basketView && model.coverage
          ? { coverage: coverageSummary(model.coverage, COMPACT_LEFT_OUT_LIMIT) }
          : {}),
        // The currency a non-USD account's returns and amounts are in, and the daily pair they converted at.
        ...(basketView && model.accountConversion ? { accountConversion: model.accountConversion } : {}),
        asOf: model.fetchedAt,
        ...(notices.length ? { notices } : {}),
      },
    };
  },
};
