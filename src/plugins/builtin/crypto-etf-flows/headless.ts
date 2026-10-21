import type { CryptoEtfFlowsPayload } from "../../../api-client/crypto-etf-flows";
import type { HeadlessPaneColumn } from "../../../types/headless";
import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { REPORT_ROWS } from "../shared/headless-options";
import { fetchCryptoEtfFlows } from "./client";
import {
  cryptoEtfFlowAsset,
  cryptoEtfFlowAssetLabel,
  cryptoEtfFlowSummary,
  formatFlow,
  formatFlowAmount,
  pendingText,
} from "./model";

const flowCell = (value: unknown) => formatFlow(typeof value === "number" ? value : null);

/** Date, the day's total and each fund, in US$ millions as published. */
function flowColumns(payload: CryptoEtfFlowsPayload): HeadlessPaneColumn[] {
  return [
    { key: "date", header: "Date", shrink: false },
    { key: "total", header: "Total", align: "right", format: flowCell },
    // A fund the day still waits on reads "pending", as in the pane; none at all is a dash.
    ...payload.funds.map((fund): HeadlessPaneColumn => ({
      key: fund.ticker, header: fund.ticker, literalHeader: true, align: "right",
      format: (value, row) => value == null && Array.isArray(row.pending) && row.pending.includes(fund.ticker) ? "pending" : flowCell(value),
    })),
    { key: "pending", header: "Pending", format: (value) => Array.isArray(value) && value.length ? value.join(", ") : "" },
  ];
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
    ],
  },
  freshness: { source: "Farside Investors", publisher: "Farside Investors", status: "not-a-feed", basis: "daily fund flows", cadence: "daily", tradingDayMarket: "US" },
  async load(args, ctx) {
    const asset = cryptoEtfFlowAsset(args.options.asset);
    const payload = await fetchCryptoEtfFlows(asset, ctx.apiClient);
    const limit = Math.max(1, Number(args.options.limit) || 20);
    const rows = payload.days.slice(0, limit).map((day) => ({
      date: day.date,
      total: day.total,
      ...Object.fromEntries(payload.funds.map((fund) => [fund.ticker, day.flows[fund.ticker] ?? null])),
      pending: day.pending,
    }));
    const summary = cryptoEtfFlowSummary(payload);
    return {
      rows,
      columns: flowColumns(payload),
      notes: [summaryLine(payload), `Source: ${payload.source.publisher}, ${payload.source.url}`],
      complete: !payload.stale,
      ...(payload.stale ? { warnings: [`The flows were last read ${payload.fetchedAt.slice(0, 10)}; newer days may be missing.`] } : {}),
      freshness: {
        source: payload.source.publisher,
        publisher: payload.source.publisher,
        status: "not-a-feed",
        basis: "daily fund flows",
        cadence: "daily",
        tradingDayMarket: "US",
        asOf: payload.asOf,
        oldest: null,
      },
      metadata: {
        asset,
        unit: payload.unit,
        asOf: payload.asOf,
        fetchedAt: payload.fetchedAt,
        stale: payload.stale,
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
