import type { PerpBoardRow } from "../../../api-client/perps";
import type { HeadlessPaneColumn, HeadlessPaneRow } from "../../../types/headless";
import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchPerpSelection, fetchPerpsHistory } from "./client";
import { compact, fundingInterval, label, marketLabel, PERP_TABS, percent, price, time, venueLabel } from "./model";

// Text columns only: the text report shows these, JSON keeps every field of every row. Rates, premiums and
// changes stay fractions in the rows; `percent` multiplies by 100 so the text agrees with the desktop pane.
const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const text = (value: unknown) => typeof value === "string" ? value : null;
const pct = (digits: number): HeadlessPaneColumn["format"] => (value) => percent(num(value), digits);
const rateOver = (rate: unknown, interval: string | null, digits = 5) => num(rate) === null ? "--" : `${percent(num(rate), digits)} /${interval ?? "--"}`;
const hours = (value: unknown) => num(value) ? `${num(value)}h` : null;
const timeColumn = (key: string, header: string): HeadlessPaneColumn => ({ key, header, format: (value) => time(text(value)) });
const right = (key: string, header: string, format: HeadlessPaneColumn["format"]): HeadlessPaneColumn => ({ key, header, align: "right", format });
const priceColumn = (key: string, header: string) => right(key, header, (value) => price(num(value)));
const oiColumn = right("openInterestUsd", "OI USD", (value) => compact(num(value)));

const asMarket = (row: HeadlessPaneRow) => row as unknown as PerpBoardRow;
const MARKET_COLUMNS: HeadlessPaneColumn[] = [
  { key: "baseAsset", header: "Market", format: (_, row) => marketLabel(asMarket(row)) },
  { key: "venue", header: "Venue", format: (_, row) => venueLabel(asMarket(row)) },
  right("markPrice", "Mark", (value, row) => num(value) === null ? "--" : `${price(num(value))} ${text(row.quoteCurrency) ?? ""}`.trim()),
  right("fundingRate", "Funding %/int", (value, row) => rateOver(value, fundingInterval(asMarket(row)))),
  right("fundingApr", "APR %", pct(2)),
  right("premium", "Premium %", pct(3)),
  oiColumn,
  right("priceChange24h", "24h %", pct(2)),
  timeColumn("observedAt", "Observed"),
];
const observationColumns = (currency: string): HeadlessPaneColumn[] => [
  timeColumn("time", "Time"),
  { key: "resolution", header: "Resolution", format: (value) => text(value) ?? "--" },
  priceColumn("markPrice", `Mark ${currency}`),
  right("premium", "Premium %", pct(3)),
  right("fundingRate", "Funding %/int", (value, row) => rateOver(value, hours(row.fundingIntervalHours))),
  oiColumn,
  right("sampleCount", "Samples", (value) => `${num(value) ?? "--"}`),
];
const FUNDING_COLUMNS: HeadlessPaneColumn[] = [
  timeColumn("time", "Time"),
  right("rate", "Paid %/int", (value, row) => rateOver(value, hours(row.intervalHours))),
  right("rate", "Funding 8h %", (value, row) => num(value) !== null && num(row.intervalHours) ? percent(num(value)! * 8 / num(row.intervalHours)!, 4) : "--"),
  right("premium", "Premium %", pct(3)),
  timeColumn("observedAt", "Observed"),
];
const candleColumns = (currency: string): HeadlessPaneColumn[] => [
  timeColumn("time", "Time"),
  priceColumn("open", "Open"), priceColumn("high", "High"), priceColumn("low", "Low"), priceColumn("close", `Close ${currency}`),
  right("volumeBase", "Volume (base)", (value) => compact(num(value))),
  right("trades", "Trades", (value) => num(value)?.toLocaleString("en-US") ?? "--"),
];
const REVISION_COLUMNS: HeadlessPaneColumn[] = [
  { key: "kind", header: "Kind", format: (value) => text(value) ? label(text(value)!) : "--" },
  timeColumn("period_at", "Period"),
  timeColumn("received_at", "Received"),
  { key: "superseded_at", header: "Status", format: (value) => text(value) ? `Superseded ${time(text(value))}` : "Current" },
  { key: "fingerprint", header: "Fingerprint", format: (value) => text(value)?.slice(0, 8) || "--" },
];

// With no market the report shows the first; a market nothing matches names the others as examples.
const EXAMPLE_MARKETS = ["BTC", "ETH", "SOL"] as const;
const DEFAULT_MARKET = EXAMPLE_MARKETS[0];

export const perpsHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "free-text", optional: true, placeholder: "market", description: `Base asset, underlying or canonical market identity, such as BTC or hyperliquid:xyz:TSLA. Defaults to ${DEFAULT_MARKET}.` },
  options: [
    { key: "tab", type: "enum", settingKey: "tab", values: PERP_TABS.map((value) => ({ value })), defaultValue: "history", description: "Per-market history or evidence." },
    { key: "days", type: "enum", settingKey: "days", values: ["1", "7", "30", "90", "365"].map((value) => ({ value })), defaultValue: "7", description: "History lookback in days." },
    { key: "metric", type: "enum", settingKey: "metric", values: ["funding", "oi", "premium", "price"].map((value) => ({ value })), defaultValue: "funding", description: "Displayed history chart; JSON retains every series." },
  ],
  discovery: { aliases: ["PERP"], dataRequirements: ["Perpetual market observations"], limitations: ["Pro history with latest-value free previews", "Rates, premiums and changes are fractions in JSON", "Open-interest history begins at first collection", "Funding APR is a simple annualization, not a forecast"] },
  describe: "Perpetual history and evidence (Pro)",
  async load(args, ctx) {
    const requested = String(Array.isArray(args.argument) ? args.argument.join(" ") : args.argument ?? "").trim();
    const search = requested || DEFAULT_MARKET;
    const market = await fetchPerpSelection(search, ctx.apiClient);
    const selected = market.rows[0];
    if (!selected) throw new Error(`No perpetual market matches "${search}". Try ${EXAMPLE_MARKETS.join(", ")}.`);
    const defaulted = requested ? {} : { defaultArgument: DEFAULT_MARKET, notices: [`Showing ${DEFAULT_MARKET}. Try fn PERP ${EXAMPLE_MARKETS[1]}.`] };
    const metadata = { ...defaulted, marketId: selected.marketId, sourceUrl: selected.sourceUrl, observedAt: selected.observedAt, sourceAsOf: selected.sourceAsOf,
      rates: "fraction", quoteCurrency: selected.quoteCurrency, oiCurrency: "USD", fundingIntervalHours: selected.fundingIntervalHours };
    // The venue's market, as last polled: not a stream, and a venue trading around the clock is stale after an hour without a poll.
    const freshness = { source: venueLabel(selected), status: "delayed" as const, asOf: selected.observedAt, maxAgeMinutes: 60 };
    if (args.options.tab === "evidence") return {
      sections: [{ title: "Market evidence", columns: MARKET_COLUMNS, rows: market.rows.map((row) => ({ ...row })) }, { title: "Observation revisions", columns: REVISION_COLUMNS, rows: market.evidence.map((row) => ({ ...row })) }],
      complete: market.access === "pro" && market.status === "ok", errors: market.access !== "pro" ? ["Full evidence requires Gloom Pro"] : [], freshness,
      metadata: { ...metadata, asOf: market.asOf, access: market.access, locked: market.locked, status: market.status },
    };
    const history = await fetchPerpsHistory({ marketId: selected.marketId, from: new Date(Date.now() - Number(args.options.days ?? 7) * 86_400_000).toISOString(), resolution: "auto", limit: 5000 }, ctx.apiClient);
    return { sections: [{ title: "Latest market", columns: MARKET_COLUMNS, rows: [{ ...selected }] }, { title: "Own observations", columns: observationColumns(selected.quoteCurrency), rows: history.rows.map((row) => ({ ...row })) },
      { title: "Paid funding", columns: FUNDING_COLUMNS, rows: history.funding.map((row) => ({ ...row })) }, { title: "Hourly candles", columns: candleColumns(selected.quoteCurrency), rows: history.candles.map((row) => ({ ...row })) }],
      complete: !history.locked && !history.truncated && history.status === "ok", freshness,
      errors: history.locked ? ["Full history requires Gloom Pro"] : history.truncated ? ["History reached the 5,000-observation limit; narrow the range"] : [],
      metadata: { ...metadata, asOf: history.asOf, access: history.access, locked: history.locked, status: history.status, from: history.from, to: history.to, resolution: history.resolution, truncated: history.truncated ?? false },
    };
  },
};
