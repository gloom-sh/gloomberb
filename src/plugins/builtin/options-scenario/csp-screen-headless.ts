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

/** The ranking basis and the wide flag's limit, then the names IV history has no rank for. */
export function cspScreenNotes(screen: Pick<CspScreen, "criteria" | "missingRanks">): string[] {
  return [
    `Ranked by annualised yield at the bid. Wide is a spread over ${screen.criteria.maxSpreadPercent}% of the mid (--max-spread).`,
    ...(screen.missingRanks.length ? [`No IV rank: ${screen.missingRanks.join(", ")}.`] : []),
  ];
}

export const cspScreenHeadless: HeadlessPaneDefinition<"rows"> = {
  shape: "rows",
  argument: { kind: "tickers", maximum: CSP_SCREEN_LIMIT, description: "US option underlyings to rank" },
  usListingsOnly: "Options data",
  failsWithoutData: true,
  description: "Cash-secured puts across a list, ranked by annualised yield on cash at the bid: for each name, the put nearest a delta "
    + "(0.30) on the listed expiry nearest a date or a number of days out (30), with its strike, bid, ask, spread (flagged wide over "
    + "--max-spread, never left out), delta, distance out of the money, yield at the mid and at the bid, IV rank and whether earnings fall before expiry.",
  discovery: { screenshotReadiness: "live-dom", dataRequirements: ["Current option chains", "Cloud stored implied volatility", "Earnings calendar"],
    limitations: ["Assignment, margin and the interest the cash earns are not modelled."] },
  describe: (_args, result) => {
    const criteria = (result?.metadata as { criteria?: CspScreen["criteria"] } | undefined)?.criteria;
    return ["Cash-secured puts", ...(criteria ? [cspScreenCriteriaText(criteria, Date.now())] : [])].join(" · ");
  },
  options: [
    { key: "delta", type: "string", placeholder: "0.30", example: "--delta 0.20",
      description: `Each name's put is the one whose delta is nearest this, as a put's delta reads without its sign. Default ${CSP_SCREEN_DEFAULTS.delta.toFixed(2)}` },
    { key: "days", type: "string", placeholder: "days", example: "--days 45",
      description: `Each name's expiry is its listed one nearest this many calendar days out. Default ${CSP_SCREEN_DEFAULTS.days}` },
    { key: "expiration", type: "string", placeholder: OPTION_EXPIRATION_PLACEHOLDER, example: "--expiration 2026-11-20",
      description: `Each name's expiry is its listed one nearest this date, in place of --days, as ${OPTION_EXPIRATION_FORMAT}`,
      normalize: (value) => expirationOptionSeconds(value) },
    { key: "maxSpread", aliases: ["max-spread"], type: "string", placeholder: "percent", example: "--max-spread 15",
      description: `A put whose bid/ask spread is over this percent of its mid is marked wide; it is still ranked. Default ${CSP_SCREEN_DEFAULTS.maxSpreadPercent}` },
  ],
  async load(args, ctx) {
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
