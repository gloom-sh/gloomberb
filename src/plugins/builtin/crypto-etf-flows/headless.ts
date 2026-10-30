import type { CryptoEtfFlowsPayload } from "../../../api-client/crypto-etf-flows";
import type { HeadlessPaneColumn } from "../../../types/headless";
import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { REPORT_ROWS } from "../shared/headless-options";
import { readPriceWindow, type PriceWindow } from "../../../utils/price-window";
import { fetchCryptoEtfFlows } from "./client";
import {
  cryptoEtfFlowAsset,
  cryptoEtfFlowAssetLabel,
  cryptoEtfFlowSummary,
  formatFlow,
  formatFlowAmount,
  formatPriceChange,
  hasFundPriceChanges,
  pendingText,
} from "./model";

const flowCell = (value: unknown) => formatFlow(typeof value === "number" ? value : null);
const optionText = (value: unknown) => typeof value === "string" && value.trim() ? value : undefined;

/** Date, the day's total, the funds' price move when served, and each fund, in US$ millions as published. */
function flowColumns(payload: CryptoEtfFlowsPayload): HeadlessPaneColumn[] {
  return [
    { key: "date", header: "Date", shrink: false },
    { key: "total", header: "Total", align: "right", format: flowCell },
    ...hasFundPriceChanges(payload)
      ? [{ key: "priceChangePct", header: "Price %", literalHeader: true, align: "right" as const, format: (value: unknown) => formatPriceChange(typeof value === "number" ? value : null) }]
      : [],
    // A fund the day still waits on reads "pending", as in the pane; none at all is a dash.
    ...payload.funds.map((fund): HeadlessPaneColumn => ({
      key: fund.ticker, header: fund.ticker, literalHeader: true, align: "right",
      format: (value, row) => value == null && Array.isArray(row.pending) && row.pending.includes(fund.ticker) ? "pending" : flowCell(value),
    })),
    { key: "pending", header: "Pending", format: (value) => Array.isArray(value) && value.length ? value.join(", ") : "" },
  ];
}

/** "Net flows of the US spot bitcoin ETFs in US$ millions. 2026-10-19 to 2026-10-23: +$301.20M over 5 trading days." */
function windowSummaryLine(payload: CryptoEtfFlowsPayload, window: PriceWindow, days: CryptoEtfFlowsPayload["days"]): string {
  const total = days.some((day) => day.total != null) ? days.reduce((sum, day) => sum + (day.total ?? 0), 0) : null;
  return `Net flows of the US spot ${cryptoEtfFlowAssetLabel(payload.asset).toLowerCase()} ETFs in US$ millions. ${window.from} to ${window.to}: `
    + `${formatFlowAmount(total)} over ${days.length} trading ${days.length === 1 ? "day" : "days"}.`;
}

/** "Net flows of the US spot bitcoin ETFs in US$ millions. 2026-10-20: -$6.70M (IBIT pending); 5 days ..., since 2024-01-11 +$57.47B." */
function summaryLine(payload: CryptoEtfFlowsPayload): string {
  const summary = cryptoEtfFlowSummary(payload);
  const pending = pendingText(summary.latest);
  return [
    `Net flows of the US spot ${cryptoEtfFlowAssetLabel(payload.asset).toLowerCase()} ETFs in US$ millions.`,
    `${summary.latest?.date ?? payload.asOf}: ${formatFlowAmount(summary.latest?.total)}${pending ? ` (${pending})` : ""};`,
    [
      summary.week != null ? `5 days ${formatFlowAmount(summary.week)}` : null,
      summary.month != null ? `20 days ${formatFlowAmount(summary.month)}` : null,
      summary.firstDate ? `since ${summary.firstDate} ${formatFlowAmount(summary.sinceLaunch)}` : null,
    ].filter(Boolean).join(", ") + ".",
  ].join(" ");
}

/**
 * "Funds: IBIT iShares Bitcoin Trust ETF, ..., BTC Grayscale Bitcoin Mini Trust ETF.": a column is headed by
 * the fund's ticker, and BTC or ETH there is Grayscale's mini fund, not the coin. Null when no fund is named.
 */
function fundsLine(payload: CryptoEtfFlowsPayload): string | null {
  const named = payload.funds.flatMap((fund) => fund.name ? [`${fund.ticker} ${fund.name}`] : []);
  return named.length ? `Funds: ${named.join(", ")}.` : null;
}

export const cryptoEtfFlowsHeadless: HeadlessPaneDefinition<"rows"> = {
  shape: "rows",
  argument: { kind: "none" },
  options: [
    {
      key: "asset",
      description: "The spot bitcoin or ether ETFs.",
      type: "enum",
      values: [
        { value: "btc", aliases: ["bitcoin", "xbt"] },
        { value: "eth", aliases: ["ether", "ethereum"] },
      ],
      defaultValue: "btc",
      example: "--asset eth",
      settingKey: "asset",
    },
    {
      key: "limit",
      shot: REPORT_ROWS,
      aliases: ["count", "rows", "days"],
      description: "Most recent trading days listed.",
      type: "integer",
      defaultValue: 20,
      minimum: 1,
      maximum: 2000,
    },
    {
      key: "from",
      type: "string",
      placeholder: "year|date",
      description: "First US trading day listed, as a year (2024) or a date (2026-10-19); lists every day of the window in place of --limit.",
      example: "--from 2026-10-19 --to 2026-10-23",
      shot: { reportOnly: "lists the report's days for those dates" },
      replaces: ["limit"],
    },
    {
      key: "to",
      type: "string",
      placeholder: "year|date",
      description: "Last US trading day listed, with --from (default the newest).",
      shot: { reportOnly: "lists the report's days for those dates" },
    },
  ],
  columns: [
    { key: "date", header: "Date" },
    { key: "total", header: "Total", align: "right", format: flowCell },
  ],
  describe: (args) => `Crypto ETF Flows | ${cryptoEtfFlowAssetLabel(cryptoEtfFlowAsset(args.options.asset))}`,
  discovery: {
    aliases: ["ETFF"],
    dataRequirements: ["Gloom Cloud spot crypto ETF flows"],
    limitations: [
      "US spot bitcoin and ether ETFs only, net creations and redemptions in US$ millions as Farside Investors publishes them.",
      "The newest day fills in fund by fund; a fund that has not reported shows as pending.",
      "0.0 is a day the fund reported no creations or redemptions; a dash is a day with no figure published for it.",
      "Price % is the funds' price move that day: the median of their close-to-close changes.",
    ],
  },
  // Stale once a trading day's flows are missing (the load's `cadence`), except in a window that ended before the newest day.
  freshness: { source: "Farside Investors", publisher: "Farside Investors", status: "not-a-feed", basis: "daily fund flows", tradingDayMarket: "US" },
  async load(args, ctx) {
    const asset = cryptoEtfFlowAsset(args.options.asset);
    // --from 2026-10-19 --to 2026-10-23 lists those days, every one of them, in place of the newest --limit.
    const window = readPriceWindow(optionText(args.options.from), optionText(args.options.to));
    const payload = await fetchCryptoEtfFlows(asset, ctx.apiClient);
    const limit = Math.max(1, Number(args.options.limit) || 20);
    const days = window ? payload.days.filter((day) => day.date >= window.from && day.date <= window.to) : payload.days.slice(0, limit);
    const priced = hasFundPriceChanges(payload);
    const rows = days.map((day) => ({
      date: day.date,
      total: day.total,
      ...(priced ? { priceChangePct: day.priceChangePct ?? null } : {}),
      ...Object.fromEntries(payload.funds.map((fund) => [fund.ticker, day.flows[fund.ticker] ?? null])),
      pending: day.pending,
    }));
    const summary = cryptoEtfFlowSummary(payload);
    const funds = fundsLine(payload);
    // A window that ends before the newest day is dated by its own last day.
    const asOf = window ? days[0]?.date ?? null : payload.asOf;
    return {
      rows,
      columns: flowColumns(payload),
      ...(window && !days.length ? { errors: [`No US trading day with flows from ${window.from} to ${window.to}.`] } : {}),
      notes: [window ? windowSummaryLine(payload, window, days) : summaryLine(payload), ...funds ? [funds] : [], `Source: ${payload.source.publisher}, ${payload.source.url}`],
      complete: !payload.stale,
      ...(payload.stale ? { warnings: [`The flows were last read ${payload.fetchedAt.slice(0, 10)}; newer days may be missing.`] } : {}),
      freshness: {
        source: payload.source.publisher,
        publisher: payload.source.publisher,
        status: "not-a-feed",
        basis: "daily fund flows",
        ...(window && asOf !== payload.asOf ? {} : { cadence: "daily" as const }),
        tradingDayMarket: "US",
        ...(asOf ? { asOf } : {}),
        oldest: null,
        // When the server last read the publisher's table, which is what this report retrieved.
        retrievedAt: payload.fetchedAt,
      },
      metadata: {
        asset,
        unit: payload.unit,
        asOf: payload.asOf,
        fetchedAt: payload.fetchedAt,
        stale: payload.stale,
        ...(window ? { requestedWindow: window } : {}),
        ...(priced ? { priceChangeBasis: "median of the funds' close-to-close price changes, percent" } : {}),
        source: payload.source,
        funds: payload.funds,
        summary: {
          latest: summary.latest ? { date: summary.latest.date, total: summary.latest.total, pending: summary.latest.pending } : null,
          fiveDays: summary.week,
          twentyDays: summary.month,
          sinceLaunch: summary.sinceLaunch,
          firstDate: summary.firstDate,
        },
      },
    };
  },
};
