import type { HeadlessPaneColumn, HeadlessPaneDefinition } from "../../../types/plugin";
import { expirationOptionSeconds, OPTION_EXPIRATION_FORMAT, OPTION_EXPIRATION_PLACEHOLDER } from "../../../utils/option-expiry";
import { resolveHeadlessInstrument } from "../shared/headless-market-data";
import { createScenarioDependencies } from "./client";
import { formatHedgePrice } from "./hedge";
import { exportPercent } from "./model";
import {
  CSP_SCREEN_DEFAULTS, CSP_SCREEN_LIMIT, cspEarningsText, cspScreenCriteriaText, loadCspScreen, readCspScreenCriteria,
  type CspScreen, type CspScreenRow,
} from "./csp-screen";
import {
  loadStrategyScreen, readStrategyFamily, readStrategyScreenCriteria, STRATEGY_FAMILY_DEFS, strategyFamilyDef,
  strategyRankedBy, strategyScreenCriteriaText, type ScreenFamily, type StrategyScreen, type StrategyScreenCriteria, type StrategyScreenRow,
} from "./strategy-screen";

const percentCell = (digits: number) => (value: unknown) => typeof value === "number" ? `${value.toFixed(digits)}%` : "--";
const priceCell = (value: unknown) => typeof value === "number" ? formatHedgePrice(value) : "--";
const strikeCell = (value: unknown) => typeof value === "number" ? String(value) : "--";

/** One name's row, flat, every percent in percent. */
export type CspScreenReportRow = {
  rank: number | null; symbol: string; expiry: string | null; days: number | null; strike: number | null;
  bid: number | null; ask: number | null; spread: number | null; wide: boolean | null; delta: number | null; otm: number | null;
  midYield: number | null; bidYield: number | null; ivRank: number | null;
  earnings: string; earningsBeforeExpiry: boolean | null; earningsDate: string | null; spot: number | null; note: string | null;
};

export function cspScreenReportRow(row: CspScreenRow): CspScreenReportRow {
  const { csp } = row;
  return {
    rank: row.rank, symbol: row.symbol,
    expiry: csp?.expiry ?? null, days: csp?.daysToExpiry ?? null, strike: csp?.strike ?? null,
    bid: csp?.quote?.bid ?? null, ask: csp?.quote?.ask ?? null, spread: exportPercent(csp?.quote?.spreadOfMid), wide: csp?.quote ? row.wideSpread : null,
    delta: row.delta, otm: exportPercent(csp?.outOfTheMoney), midYield: exportPercent(csp?.annualizedYield),
    bidYield: exportPercent(csp?.quote?.bidAnnualizedYield), ivRank: row.ivRank,
    earnings: cspEarningsText(csp), earningsBeforeExpiry: csp ? csp.earnings.beforeExpiry : null, earningsDate: csp?.earnings.date ?? null,
    spot: csp?.spot ?? null, note: row.note,
  };
}

const COLUMNS: HeadlessPaneColumn[] = [
  { key: "rank", header: "#", align: "right", format: (value) => typeof value === "number" ? String(value) : "" },
  { key: "symbol", header: "Symbol" },
  { key: "expiry", header: "Expiry" },
  { key: "days", header: "DTE", align: "right" },
  { key: "strike", header: "Strike", align: "right", format: strikeCell },
  { key: "bid", header: "Bid", align: "right", format: priceCell },
  { key: "ask", header: "Ask", align: "right", format: priceCell },
  // The text view marks a wide spread in its cell; exports keep the number and say so in Wide.
  { key: "spread", header: "Spread", align: "right", format: percentCell(1),
    textFormat: (value, row) => `${percentCell(1)(value)}${row.wide ? " wide" : ""}` },
  { key: "delta", header: "Delta", align: "right", format: (value) => typeof value === "number" ? value.toFixed(2) : "--" },
  { key: "otm", header: "OTM", align: "right", format: percentCell(1) },
  { key: "midYield", header: "Mid yield/yr", align: "right", format: percentCell(2) },
  { key: "bidYield", header: "Bid yield/yr", align: "right", format: percentCell(2) },
  { key: "ivRank", header: "IVR", align: "right", format: (value) => typeof value === "number" ? value.toFixed(0) : "--" },
  { key: "earnings", header: "Earnings" },
];
const NOTE: HeadlessPaneColumn = { key: "note", header: "Note", underRow: true };
const EXPORT_ONLY: HeadlessPaneColumn[] = [
  { key: "wide", header: "Wide spread", format: (value) => value === true ? "yes" : value === false ? "no" : "" },
  { key: "earningsBeforeExpiry", header: "Earnings before expiry", format: (value) => value === true ? "yes" : value === false ? "no" : "unknown" },
  { key: "earningsDate", header: "Earnings date" },
  { key: "spot", header: "Spot", format: priceCell },
];

/** `A`, `A and B`, `A, B and C`. */
const listText = (items: readonly string[]) => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/**
 * The ranking basis and the wide flag's limit, then the names IV history has no
 * rank for: those with a reason say it (`No IV rank: BBB (fewer than 120
 * sessions).`), and a bare symbol, which has none to give, is just not ranked
 * yet (`No IV rank for DAL yet.`).
 */
export function cspScreenNotes(
  screen: { criteria: Pick<CspScreen["criteria"], "maxSpreadPercent">; missingRanks: string[] }, rankedBy = "annualised yield at the bid",
): string[] {
  const reasoned = screen.missingRanks.filter((entry) => entry.includes(" "));
  const bare = screen.missingRanks.filter((entry) => !entry.includes(" "));
  return [
    `Ranked by ${rankedBy}. Wide is a spread over ${screen.criteria.maxSpreadPercent}% of the mid (--max-spread).`,
    ...(reasoned.length ? [`No IV rank: ${reasoned.join(", ")}.`] : []),
    ...(bare.length ? [`No IV rank for ${listText(bare)} yet.`] : []),
  ];
}

const money = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * One name's trade, flat: money (credit or debit, max gain and loss) for one
 * contract a leg as OSA counts it, break-evens per share, every percent in
 * percent, reward to risk as a multiple.
 */
export type StrategyScreenReportRow = {
  rank: number | null; symbol: string; expiry: string | null; farExpiry: string | null; days: number | null; trade: string | null;
  net: number | null; maxGain: number | null; maxLoss: number | null; unlimited: "gain" | "loss" | null;
  breakEven: number | null; secondBreakEven: number | null; breakEvens: string; pop: number | null; returnToExpiry: number | null;
  returnPerYear: number | null; rewardRisk: number | null; ivRank: number | null; spread: number | null; wide: boolean | null;
  earnings: string; earningsBeforeExpiry: boolean | null; earningsDate: string | null; spot: number | null; note: string | null;
};

export function strategyScreenReportRow(row: StrategyScreenRow): StrategyScreenReportRow {
  const { trade } = row;
  return {
    rank: row.rank, symbol: row.symbol, expiry: trade?.expiry ?? null, farExpiry: trade?.farExpiry ?? null, days: trade?.daysToExpiry ?? null,
    // The screen keeps only trades whose mids open the way the family does, so the amount is the column's own credit or debit.
    trade: trade?.text ?? null, net: trade ? Math.abs(trade.netAmount) : null, maxGain: trade?.maxGain ?? null, maxLoss: trade?.maxLoss ?? null,
    unlimited: trade?.unlimited ?? null, breakEven: trade?.breakEvens[0] ?? null, secondBreakEven: trade?.breakEvens[1] ?? null,
    breakEvens: trade?.breakEvens.length ? trade.breakEvens.map((value) => value.toFixed(2)).join(" / ") : "--",
    pop: exportPercent(trade?.probabilityOfProfit), returnToExpiry: exportPercent(trade?.returnToExpiry),
    returnPerYear: exportPercent(trade?.annualizedReturn), rewardRisk: trade?.rewardToRisk ?? null,
    ivRank: row.ivRank, spread: exportPercent(trade?.quote?.spreadOfMid), wide: trade?.quote ? row.wideSpread : null,
    earnings: cspEarningsText(trade), earningsBeforeExpiry: trade ? trade.earnings.beforeExpiry : null, earningsDate: trade?.earnings.date ?? null,
    spot: trade?.spot ?? null, note: row.note,
  };
}

/** A gain or loss for one contract a leg, `unlimited` on the side that has no limit. */
const riskCell = (side: "gain" | "loss") => (value: unknown, row: Record<string, unknown>) =>
  typeof value === "number" ? money(value) : row.unlimited === side ? "unlimited" : "--";
/** `2.68x`, or `unlimited` where the gain has no limit. */
export const rewardRiskText = (value: unknown, unlimited: unknown) =>
  typeof value === "number" ? `${value.toFixed(2)}x` : unlimited === "gain" ? "unlimited" : "--";

/** The unit every money column of a trade is in, said once: OSA's own for position money. */
export const STRATEGY_MONEY_UNIT = "USD per contract";

/**
 * A family's columns: its money column is `Credit` or `Debit`; an income trade
 * reads its annualised return and a debit trade its reward to risk. A
 * calendar's trade names the expiry it buys, which exports also give alone.
 */
function strategyScreenColumns(strategy: ScreenFamily): { text: HeadlessPaneColumn[]; exported: HeadlessPaneColumn[] } {
  const def = strategyFamilyDef(strategy);
  const lead: HeadlessPaneColumn[] = [COLUMNS[0]!, COLUMNS[1]!, COLUMNS[2]!];
  const farExpiry: HeadlessPaneColumn[] = strategy === "calendar" ? [{ key: "farExpiry", header: "Bought expiry" }] : [];
  const body: HeadlessPaneColumn[] = [
    COLUMNS[3]!,
    { key: "trade", header: "Trade", format: (value) => typeof value === "string" ? value : "--" },
    { key: "net", header: def.net === "credit" ? "Credit" : "Debit", align: "right", format: (value) => typeof value === "number" ? money(value) : "--" },
    { key: "maxGain", header: "Max gain", align: "right", format: riskCell("gain") },
    { key: "maxLoss", header: "Max loss", align: "right", format: riskCell("loss") },
  ];
  const measure: HeadlessPaneColumn = def.net === "credit"
    ? { key: "returnPerYear", header: "Return/yr", align: "right", format: percentCell(1) }
    : { key: "rewardRisk", header: "Reward/risk", align: "right", format: (value, row) => rewardRiskText(value, row.unlimited) };
  const odds: HeadlessPaneColumn[] = [{ key: "pop", header: "PoP", align: "right", format: percentCell(0) }, measure, COLUMNS[12]!, COLUMNS[7]!, COLUMNS[13]!];
  const breakEven: HeadlessPaneColumn = { key: "breakEven", header: "Break-even", align: "right", format: priceCell,
    textFormat: (_value, row) => String(row.breakEvens) };
  const toExpiry: HeadlessPaneColumn[] = def.net === "credit"
    ? [{ key: "returnToExpiry", header: "Return to expiry", align: "right", format: percentCell(2) }] : [];
  return {
    text: [...lead, ...body, breakEven, ...odds, NOTE],
    exported: [...lead, ...farExpiry, ...body, breakEven, { key: "secondBreakEven", header: "Second break-even", format: priceCell }, ...odds,
      ...toExpiry, ...EXPORT_ONLY, NOTE],
  };
}

function strategyMetadata(screen: StrategyScreen) {
  return { strategy: screen.criteria.strategy, criteria: screen.criteria, rankedBy: strategyRankedBy(screen.criteria.strategy),
    unit: `credit, debit, max gain and max loss in ${STRATEGY_MONEY_UNIT} (one contract a leg, 100 shares); break-evens per share; percent; reward/risk as a multiple`,
    methodology: "docs/research-data.md#options-strategy-screen" };
}

export const cspScreenHeadless: HeadlessPaneDefinition<"rows"> = {
  shape: "rows",
  argument: { kind: "tickers", maximum: CSP_SCREEN_LIMIT, description: "US option underlyings to rank" },
  usListingsOnly: "Options data",
  failsWithoutData: true,
  description: "Option strategies across a list, one family at a time (--strategy): cash-secured puts by default, ranked by annualised yield on "
    + "cash at the bid, the put nearest a delta (0.30) on the listed expiry nearest a date or a number of days out (30), with its strike, bid, ask, "
    + "spread (flagged wide over --max-spread, never left out), delta, distance out of the money, yield at the mid and at the bid, IV rank and whether "
    + "earnings fall before expiry. Covered calls, verticals, iron condors, straddles, strangles and calendars pick their legs by delta on the same "
    + "expiry and show the trade, credit or debit, max gain and loss per contract, break-evens, probability of profit, and an income trade's "
    + "annualised return or a debit trade's reward to risk.",
  discovery: { screenshotReadiness: "live-dom", dataRequirements: ["Current option chains", "Cloud stored implied volatility", "Earnings calendar"],
    limitations: ["Assignment, margin and the interest the cash earns are not modelled.",
      "Probability of profit is the Black-Scholes chance at each break-even's nearest leg IV, not a forecast."] },
  describe: (_args, result) => {
    const metadata = result?.metadata as { criteria?: CspScreen["criteria"] | StrategyScreenCriteria; strategy?: ScreenFamily } | undefined;
    const criteria = metadata?.criteria;
    if (metadata?.strategy && criteria) {
      return [strategyFamilyDef(metadata.strategy).title, strategyScreenCriteriaText(criteria as StrategyScreenCriteria, Date.now()), STRATEGY_MONEY_UNIT]
        .join(" · ");
    }
    return ["Cash-secured puts", ...(criteria ? [cspScreenCriteriaText(criteria as CspScreen["criteria"], Date.now())] : [])].join(" · ");
  },
  options: [
    { key: "strategy", type: "enum", example: "--strategy iron-condor",
      values: STRATEGY_FAMILY_DEFS.map((def) => ({ value: def.id, ...(def.aliases.length ? { aliases: def.aliases } : {}) })),
      description: "The strategy each name trades, a cash-secured put (csp) when not given; also cc, put-credit, call-credit, call-debit, "
        + "put-debit, ic and call-calendar" },
    { key: "delta", type: "string", placeholder: "0.30", example: "--delta 0.20",
      description: `Each name's put is the one whose delta is nearest this, as a put's delta reads without its sign. Default ${CSP_SCREEN_DEFAULTS.delta.toFixed(2)}. `
        + "Other strategies pick their legs the same way: a covered call's call, a vertical's leg nearer the money, a condor's or a strangle's put and call, "
        + "a calendar's call, each strategy at its own default (0.30; 0.50 for debit verticals and calendars; 0.20 for condors and short strangles)" },
    { key: "wingDelta", aliases: ["wing-delta"], type: "string", placeholder: "0.15", example: "--strategy iron-condor --wing-delta 0.05",
      description: "A vertical's or an iron condor's legs further out of the money are the ones whose delta is nearest this: the legs a credit spread "
        + "buys and a debit spread sells. Default 0.15 (0.30 for debit verticals, 0.10 for condors), or half --delta when that is not below it" },
    { key: "days", type: "string", placeholder: "days", example: "--days 45",
      description: `Each name's expiry is its listed one nearest this many calendar days out. Default ${CSP_SCREEN_DEFAULTS.days}` },
    { key: "expiration", type: "string", placeholder: OPTION_EXPIRATION_PLACEHOLDER, example: "--expiration 2026-11-20",
      description: `Each name's expiry is its listed one nearest this date, in place of --days, as ${OPTION_EXPIRATION_FORMAT}`,
      normalize: (value) => expirationOptionSeconds(value) },
    { key: "maxSpread", aliases: ["max-spread"], type: "string", placeholder: "percent", example: "--max-spread 15",
      description: "A put whose bid/ask spread is over this percent of its mid is marked wide; it is still ranked. A strategy of several legs adds "
        + `their spreads up against its net mid. Default ${CSP_SCREEN_DEFAULTS.maxSpreadPercent}` },
  ],
  async load(args, ctx) {
    const strategy = readStrategyFamily(args.options.strategy);
    if (strategy !== "csp") return loadStrategyReport(strategy, args, ctx);
    if (args.options.wingDelta != null && args.options.wingDelta !== "") {
      throw new Error("--wing-delta sets the far legs of a vertical or an iron condor; a cash-secured put has none");
    }
    const criteria = readCspScreenCriteria(args.options);
    const instruments = await Promise.all(args.symbols.map((symbol) => resolveHeadlessInstrument(ctx, symbol)));
    const screen = await loadCspScreen(instruments, criteria, {
      scenario: createScenarioDependencies(ctx.marketData, ctx.apiClient), earnings: ctx.marketData, ivApi: ctx.apiClient,
    }, ctx.signal);
    const unavailable = screen.rows.filter((row) => !row.csp);
    return {
      freshness: screen.freshness,
      columns: [...COLUMNS, ...EXPORT_ONLY, NOTE],
      textColumns: [...COLUMNS, NOTE],
      rows: screen.rows.map(cspScreenReportRow),
      complete: unavailable.length === 0 && !screen.ivRankError,
      unavailableSymbols: unavailable.map((row) => row.symbol),
      errors: screen.ivRankError ? [`IV rank unavailable: ${screen.ivRankError}`] : [],
      notes: cspScreenNotes(screen),
      metadata: { criteria: screen.criteria, rankedBy: "annualized yield on cash at the bid", unit: "percent; prices per share",
        methodology: "docs/research-data.md#cash-secured-put-screen" },
    };
  },
};

/** `fn CSP --strategy <family>`: each name's trade of the family, ranked, with its own columns. */
async function loadStrategyReport(
  strategy: ScreenFamily, args: Parameters<HeadlessPaneDefinition["load"]>[0], ctx: Parameters<HeadlessPaneDefinition["load"]>[1],
) {
  const criteria = readStrategyScreenCriteria(strategy, args.options);
  const instruments = await Promise.all(args.symbols.map((symbol) => resolveHeadlessInstrument(ctx, symbol)));
  const screen = await loadStrategyScreen(instruments, criteria, {
    scenario: createScenarioDependencies(ctx.marketData, ctx.apiClient), earnings: ctx.marketData, ivApi: ctx.apiClient,
  }, ctx.signal);
  const unavailable = screen.rows.filter((row) => !row.trade);
  const columns = strategyScreenColumns(strategy);
  return {
    freshness: screen.freshness,
    columns: columns.exported,
    textColumns: columns.text,
    rows: screen.rows.map(strategyScreenReportRow),
    complete: unavailable.length === 0 && !screen.ivRankError,
    unavailableSymbols: unavailable.map((row) => row.symbol),
    errors: screen.ivRankError ? [`IV rank unavailable: ${screen.ivRankError}`] : [],
    notes: cspScreenNotes(screen, strategyRankedBy(strategy)),
    metadata: strategyMetadata(screen),
  };
}
