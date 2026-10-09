import type { PerpBoardPayload, PerpBoardRow } from "../../../api-client/perps";
import type { HeadlessBundleSection, HeadlessPaneColumn, HeadlessPaneLoadArgs, HeadlessPaneRow } from "../../../types/headless";
import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchPerpSelection, fetchPerpsBoard, fetchPerpsCompare, fetchPerpsHistory, fetchPerpsRankings } from "./client";
import { ASSET_FILTERS, BOARD_COLUMNS, BOARD_SORTS, COMPARE_COLUMNS, compact, fundingSpread, label, openingTab, PERP_TABS, perpCellText, perpColumnLabel, percent, price,
  RANKING_COLUMNS, rankingRows, RANKINGS, time, VENUES, venueLabel, venueName, venuesOf, type PerpColumnId } from "./model";

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
// The board, comparison and ranking columns print what the pane's cells show, through the same formatter.
const RIGHT = new Set<PerpColumnId>(["markPrice", "fundingRate", "fundingRate8h", "fundingApr", "premium", "openInterestUsd", "oiChange24h", "priceChange24h", "value"]);
const KEYS: Partial<Record<PerpColumnId, string>> = { market: "baseAsset" };
const perpColumn = (id: PerpColumnId): HeadlessPaneColumn => ({ key: KEYS[id] ?? id, header: perpColumnLabel(id), ...(RIGHT.has(id) ? { align: "right" as const } : {}),
  format: (_, row) => perpCellText(asMarket(row), id) });
// One market's row keeps its full observation time, as it always printed.
const MARKET_COLUMNS: HeadlessPaneColumn[] = BOARD_COLUMNS.filter((id) => id !== "oiChange24h").map((id) => id === "observedAt" ? timeColumn("observedAt", "Observed") : perpColumn(id));
const BOARD_TEXT_COLUMNS = BOARD_COLUMNS.map(perpColumn);
const COMPARE_TEXT_COLUMNS = COMPARE_COLUMNS.map(perpColumn);
const rankingTextColumns = (ranking: typeof RANKINGS[number]): HeadlessPaneColumn[] => RANKING_COLUMNS.map((id) => id === "value"
  ? right(ranking.field, ranking.header, pct(ranking.digits)) : perpColumn(id));
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

const requestedOf = (args: HeadlessPaneLoadArgs) => String(Array.isArray(args.argument) ? args.argument.join(" ") : args.argument ?? "").trim();
// No tab named: a market opens its history, nothing opens the board, as the pane does.
const tabOf = (args: HeadlessPaneLoadArgs) => PERP_TABS.find((tab) => tab === args.options.tab) ?? openingTab(requestedOf(args));
const TITLES: Record<typeof PERP_TABS[number], string> = { board: "Perpetual markets", rankings: "Perpetual rankings", compare: "Perpetual contracts across venues",
  history: "Perpetual history (Pro)", evidence: "Perpetual evidence (Pro)" };
const copy = (rows: readonly PerpBoardRow[]) => rows.map((row) => ({ ...row }));
const more = (count: number, noun: string) => `${count.toLocaleString("en-US")} more ${noun} need Gloom Pro`;
// Many venues' markets, each as last polled: cited by venue, stale after an hour without a poll.
const listFreshness = (rows: readonly PerpBoardRow[], asOf: string | null, venue = "all") => {
  const source = rows.length ? venuesOf(rows).map(venueName).join(", ") : venue !== "all" ? venueName(venue) : null;
  return { ...(source ? { source } : {}), status: "delayed" as const, asOf, maxAgeMinutes: 60 };
};
const listMetadata = (data: Pick<PerpBoardPayload, "asOf" | "access" | "status"> & { locked: number | boolean }) => ({ asOf: data.asOf, access: data.access, locked: data.locked, status: data.status, rates: "fraction", oiCurrency: "USD" });

export const perpsHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "free-text", optional: true, placeholder: "market",
    description: "A base asset, underlying or canonical market identity, such as BTC or hyperliquid:xyz:TSLA. Opens its history; with --tab board it searches the board, with --tab compare it is the base asset. Without one, the board." },
  options: [
    { key: "tab", type: "enum", settingKey: "tab", values: PERP_TABS.map((value) => ({ value })), description: "Board, rankings, compare, history or evidence. Board without a market, history with one." },
    { key: "asset-class", type: "enum", settingKey: "assetClass", values: ASSET_FILTERS.map((value) => ({ value })), defaultValue: "all", description: "Board asset class." },
    { key: "venue", type: "enum", settingKey: "venue", values: ["all", ...VENUES].map((value) => ({ value })), defaultValue: "all", description: "Board venue." },
    { key: "sort", type: "enum", settingKey: "sort", values: BOARD_SORTS.map((value) => ({ value })), defaultValue: "oi", description: "Board order: open interest, funding, open-interest change or premium." },
    { key: "days", type: "enum", settingKey: "days", values: ["1", "7", "30", "90", "365"].map((value) => ({ value })), defaultValue: "7", description: "History lookback in days." },
    { key: "metric", type: "enum", settingKey: "metric", values: ["funding", "oi", "premium", "price"].map((value) => ({ value })), defaultValue: "funding", description: "Displayed history chart; JSON retains every series." },
  ],
  discovery: { aliases: ["PERP"], dataRequirements: ["Perpetual market observations"], limitations: ["Free accounts see a fixed preview of the board, rankings and comparisons, and latest values for one market", "Pro unlocks every market, full rankings and history", "Rankings list up to ten markets each", "Rates, premiums and changes are fractions in JSON", "Open-interest history begins at first collection", "Funding APR is a simple annualization, not a forecast"] },
  describe: (args) => TITLES[tabOf(args)],
  async load(args, ctx) {
    const requested = requestedOf(args);
    const tab = tabOf(args);
    if (tab === "board") {
      const assetClass = String(args.options["asset-class"] ?? "all"), venue = String(args.options.venue ?? "all"), sort = String(args.options.sort ?? "oi");
      const board = await fetchPerpsBoard({ ...(assetClass !== "all" ? { assetClass } : {}), ...(requested ? { search: requested } : {}), sort }, ctx.apiClient);
      const rows = venue === "all" ? board.rows : board.rows.filter((row) => row.venue === venue);
      return { sections: [{ title: "Markets", columns: BOARD_TEXT_COLUMNS, rows: copy(rows) }], complete: !board.locked && board.status === "ok",
        errors: board.locked ? [more(board.locked, "markets")] : [], freshness: listFreshness(rows, board.asOf, venue),
        metadata: { ...listMetadata(board), total: board.total, assetClass, venue, sort, ...(requested ? { search: requested } : {}) } };
    }
    if (tab === "rankings") {
      const rankings = await fetchPerpsRankings(ctx.apiClient);
      const sections: HeadlessBundleSection[] = RANKINGS.map((ranking) => ({ title: ranking.label, columns: rankingTextColumns(ranking), rows: copy(rankingRows(rankings, ranking.key)) }));
      return { sections, complete: !rankings.locked && rankings.status === "ok", errors: rankings.locked ? ["Full rankings need Gloom Pro"] : [],
        freshness: listFreshness(RANKINGS.flatMap((ranking) => rankingRows(rankings, ranking.key)), rankings.asOf), metadata: listMetadata(rankings) };
    }
    if (tab === "compare") {
      // A canonical identity names one contract; its base asset is what the venues share.
      const base = requested.includes(":") ? (await fetchPerpSelection(requested, ctx.apiClient)).rows[0]?.baseAsset ?? requested : (requested || DEFAULT_MARKET).toUpperCase();
      const compare = await fetchPerpsCompare(base, ctx.apiClient);
      if (!compare.rows.length && !compare.locked) throw new Error(`No perpetual market matches "${requested || base}". Try ${EXAMPLE_MARKETS.join(", ")}.`);
      const spread = fundingSpread(compare.rows);
      return { sections: [{ title: "Contracts", columns: COMPARE_TEXT_COLUMNS, rows: copy(compare.rows) },
        ...(spread ? [{ title: "Funding spread", entries: [{ key: "fundingSpread8h", label: "Funding spread 8h", value: spread.value, formatted: `${spread.text} ${spread.detail}` }] }] : [])],
        complete: !compare.locked && compare.status === "ok", errors: compare.locked ? [more(compare.locked, compare.locked === 1 ? "contract" : "contracts")] : [],
        freshness: listFreshness(compare.rows, compare.asOf),
        metadata: { ...(requested ? {} : { defaultArgument: DEFAULT_MARKET, notices: [`Showing ${DEFAULT_MARKET}. Try fn PERP ${EXAMPLE_MARKETS[1]} --tab compare.`] }),
          ...listMetadata(compare), total: compare.total, baseAsset: base,
          ...(spread ? { fundingSpread8h: spread.value, fundingSpreadHigh: spread.high.marketId, fundingSpreadLow: spread.low.marketId } : {}) } };
    }
    const search = requested || DEFAULT_MARKET;
    const market = await fetchPerpSelection(search, ctx.apiClient);
    const selected = market.rows[0];
    if (!selected) throw new Error(`No perpetual market matches "${search}". Try ${EXAMPLE_MARKETS.join(", ")}.`);
    const defaulted = requested ? {} : { defaultArgument: DEFAULT_MARKET, notices: [`Showing ${DEFAULT_MARKET}. Try fn PERP ${EXAMPLE_MARKETS[1]}.`] };
    const metadata = { ...defaulted, marketId: selected.marketId, sourceUrl: selected.sourceUrl, observedAt: selected.observedAt, sourceAsOf: selected.sourceAsOf,
      rates: "fraction", quoteCurrency: selected.quoteCurrency, oiCurrency: "USD", fundingIntervalHours: selected.fundingIntervalHours };
    // The venue's market, as last polled: not a stream, and a venue trading around the clock is stale after an hour without a poll.
    const freshness = { source: venueLabel(selected), status: "delayed" as const, asOf: selected.observedAt, maxAgeMinutes: 60 };
    if (tab === "evidence") return {
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
