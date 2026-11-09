import type { PerpBoardPayload, PerpBoardRow, PerpDepthRow, PerpLiquidationMarket, PerpLiquidationPrint, PerpLiquidationsPayload } from "../../../api-client/perps";
import type { HeadlessBundleResult, HeadlessBundleSection, HeadlessPaneColumn, HeadlessPaneContext, HeadlessPaneLoadArgs, HeadlessPaneRow } from "../../../types/headless";
import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { DEPTH_COLUMN_IDS, depthBandTotals, depthCellText, depthColumnLabel, depthFreshness, depthStaleNote, downStreams, LIQUIDATION_COLUMN_IDS, liquidationCellText, liquidationColumnLabel, liquidationFreshness,
  PRINT_COLUMN_IDS, printCellText, printColumnLabel, type DepthColumnId, type LiquidationColumnId, type PrintColumnId } from "./cascade";
import { boardSearchText, fetchPerpSelection, fetchPerpsBoard, fetchPerpsCompare, fetchPerpsDepth, fetchPerpsHistory, fetchPerpsLiquidations, fetchPerpsRankings, marketQuery, nearestPerpMarkets } from "./client";
import { perpFreshness } from "./freshness";
import { aprFootnote, ASSET_FILTERS, BOARD_COLUMNS, BOARD_SORTS, collectedVenueCount, COMPARE_COLUMNS, compact, fundingSpread, HISTORY_METRICS, label, marketLabel, observed, openingTab, PERP_TABS, perpCellText,
  perpColumnLabel, percent, perpHistoryProText, positioningFields, price, RANKING_COLUMNS, rankingRows, RANKINGS, ratioText, share, time, uncoveredVenueNote, VENUES, venueAprSummary, venueName, venuesOf, IDENTITY_VENUES,
  type PerpColumnId } from "./model";
import { freePreviewNote } from "../shared/free-preview";
import { REPORT_ROWS } from "../shared/headless-options";
import { basisSpotSymbol } from "../futures-curve/model";

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
const RIGHT = new Set<PerpColumnId>(["markPrice", "fundingRate", "fundingRate8h", "fundingApr", "premium", "openInterestUsd", "oiChange24h", "longShare", "priceChange24h", "value"]);
const KEYS: Partial<Record<PerpColumnId, string>> = { market: "baseAsset", longShare: "longShortRatio" };
const DESCRIPTIONS: Partial<Record<PerpColumnId, string>> = { longShare: "Share of accounts net long on the contract, by each venue's own definition and hourly bucket" };
// A narrow table keeps APR % on the row: the raw rates it annualises move under the row first, the per-interval one before the 8h one.
const STACK_FIRST: Partial<Record<PerpColumnId, number>> = { fundingRate: 2, fundingRate8h: 1 };
const perpColumn = (id: PerpColumnId): HeadlessPaneColumn => ({ key: KEYS[id] ?? id, header: perpColumnLabel(id), ...(RIGHT.has(id) ? { align: "right" as const } : {}),
  ...(DESCRIPTIONS[id] ? { description: DESCRIPTIONS[id] } : {}), ...(STACK_FIRST[id] ? { stackPriority: STACK_FIRST[id] } : {}), format: (_, row) => perpCellText(asMarket(row), id) });
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
const LONG_SHORT_COLUMNS: HeadlessPaneColumn[] = [
  timeColumn("time", "Bucket"),
  right("longShare", "Long %", (value) => share(num(value), 2)),
  right("shortShare", "Short %", (value) => share(num(value), 2)),
  right("ratio", "Ratio", (value) => ratioText(num(value))),
  { key: "derived", header: "Shares", format: (value) => value === true ? "From ratio" : "Published" },
  timeColumn("observedAt", "Observed"),
];
const REVISION_COLUMNS: HeadlessPaneColumn[] = [
  { key: "kind", header: "Kind", format: (value) => text(value) ? label(text(value)!) : "--" },
  timeColumn("period_at", "Period"),
  timeColumn("received_at", "Received"),
  { key: "superseded_at", header: "Status", format: (value) => text(value) ? `Superseded ${time(text(value))}` : "Current" },
  { key: "fingerprint", header: "Fingerprint", format: (value) => text(value)?.slice(0, 8) || "--" },
];

// Liquidations and depth print what their tabs' cells show, through the same formatters.
const LIQUIDATION_RIGHT = new Set<string>(["long24h", "short24h", "long7d", "short7d", "count24h", "notionalUsd", "price", "quantity", "mid", "bid05", "ask05", "bid1", "ask1", "bid2", "ask2", "reach"]);
const cascadeColumn = <Id extends string>(id: Id, header: string, format: (row: HeadlessPaneRow) => string): HeadlessPaneColumn =>
  ({ key: id === "reach" ? "bidReach" : id, header, ...(LIQUIDATION_RIGHT.has(id) ? { align: "right" as const } : {}), format: (_, row) => format(row) });
const LIQUIDATION_TEXT_COLUMNS = LIQUIDATION_COLUMN_IDS.map((id: LiquidationColumnId) => cascadeColumn(id, liquidationColumnLabel(id), (row) => liquidationCellText(row as unknown as PerpLiquidationMarket, id)));
const printTextColumns = (base: string) => PRINT_COLUMN_IDS.map((id: PrintColumnId) => cascadeColumn(id, printColumnLabel(id, base), (row) => printCellText(row as unknown as PerpLiquidationPrint, id)));
const DEPTH_TEXT_COLUMNS = DEPTH_COLUMN_IDS.map((id: DepthColumnId) => cascadeColumn(id, depthColumnLabel(id), (row) => depthCellText(row as unknown as PerpDepthRow, id)));
const HOURLY_COLUMNS: HeadlessPaneColumn[] = [timeColumn("time", "Hour"), right("long", "Longs USD", (value) => compact(num(value))), right("short", "Shorts USD", (value) => compact(num(value))),
  right("count", "Events", (value) => num(value)?.toLocaleString("en-US") ?? "--")];
const DEPTH_HISTORY_COLUMNS: HeadlessPaneColumn[] = [{ key: "marketId", header: "Market", format: (value) => text(value) ?? "--" }, timeColumn("bucket", "Hour"),
  ...(["bid05", "ask05", "bid1", "ask1", "bid2", "ask2"] as const).map((id) => right(id, depthColumnLabel(id), (value) => compact(num(value))))];

// With no market the report shows the first; a market nothing matches names ones that work, a builder dex's among them.
const EXAMPLE_MARKETS = ["BTC", "ETH", "SOL"] as const;
const DEFAULT_MARKET = EXAMPLE_MARKETS[0];
const EXAMPLE_NAMES = ["BTC", "ETH", "SP500", "xyz:SP500"];
// The names nearest what was typed when the board has some, else the examples.
const noMarket = (input: string, nearest: readonly string[] = []) => new Error(`No perpetual market matches "${input}". Try ${(nearest.length ? nearest : EXAMPLE_NAMES).join(", ")}.`);
/** A pair or plain name read as the market it stands for says so, and names the other contracts that fit it. */
const readAs = (shown: string, requested: string, others: readonly string[] = []) =>
  [`Showing ${shown} for "${requested}".${others.length ? ` Also on the board: ${others.join(", ")}.` : ""}`];
/** A contract's funding interval as an export names it, `8h`; null where its venue states none. */
const intervalOf = (row: PerpBoardRow) => row.fundingIntervalHours ? `${row.fundingIntervalHours}h` : null;
/**
 * Market rows as an export cites each one apart: its venue (`source`), the identity `fn PERP` opens it by
 * (`symbol_or_series`), its quote unit, funding interval and observed time, with its source URL and the hour its
 * long share is bucketed in beside the figures. JSON keeps these fields too.
 */
const citedRows = (rows: readonly PerpBoardRow[]) => rows.map((row) => ({ ...row, venueName: venueName(row.venue), fundingInterval: intervalOf(row),
  longShareBucketAt: row.longShortRatio?.bucketAt ?? null }));
const CITED_KEYS = { rowSourceKey: "venueName", rowSymbolKey: "marketId", rowUnitKey: "quoteCurrency", rowIntervalKey: "fundingInterval", rowAsOfKey: "observedAt" };
/** The exported columns of market rows: the text's, Mark a number in the row's quote unit (`currency_or_unit`), then the long share's bucket and the source URL. */
const exportColumns = (columns: readonly HeadlessPaneColumn[]): HeadlessPaneColumn[] => [
  ...columns.map((column) => column.key === "markPrice" ? { ...column, unitKey: "quoteCurrency" } : column),
  ...columns.some((column) => column.key === "longShortRatio") ? [{ key: "longShareBucketAt", header: "Long % bucket UTC" }] : [],
  { key: "sourceUrl", header: "Source URL" },
];
/** A table of market rows: the pane's columns in the text, every row cited on its own in the exports. */
const marketSection = (title: string, columns: HeadlessPaneColumn[], rows: readonly PerpBoardRow[]) =>
  ({ title, columns: exportColumns(columns), textColumns: columns, rows: citedRows(rows), ...CITED_KEYS });
/** The stablecoins OI USD counts at one dollar, from the rows whose venue figures were converted so. */
function parityNote(rows: readonly PerpBoardRow[]): string | null {
  const coins = [...new Set(rows.filter((row) => row.qualityFlags.includes("stablecoin-usd-parity-assumed")).map((row) => row.quoteCurrency))].sort();
  return coins.length ? `OI USD values ${coins.join(" and ")} at 1 USD.` : null;
}
/** When the Long % shares were counted: each venue's hourly bucket, which is not the row's Observed time. */
function longShareNote(rows: readonly PerpBoardRow[]): string | null {
  const buckets = new Map<string, Set<string>>();
  for (const row of rows) {
    const bucket = row.longShortRatio?.bucketAt;
    if (bucket) buckets.set(observed(bucket), (buckets.get(observed(bucket)) ?? new Set()).add(venueName(row.venue)));
  }
  if (!buckets.size) return null;
  const when = buckets.size === 1 ? `from ${[...buckets.keys()][0]} UTC`
    : `(${[...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([bucket, venues]) => `${[...venues].sort().join(", ")} ${bucket}`).join("; ")} UTC)`;
  return `Long % is each venue's hourly account bucket ${when}, not its Observed time.`;
}
// The APR % column is the current rate carried forward a year at each market's own interval, so a table that shows it says how;
// OI USD says which stablecoins it counts at a dollar, and Long % which hour it was counted in.
// `aprRows` are every row an APR is shown for, where a line beside the table annualises more markets than it lists.
const aprNote = (rows: readonly PerpBoardRow[], { apr = true, longShare = true, aprRows = rows }: { apr?: boolean; longShare?: boolean; aprRows?: readonly PerpBoardRow[] } = {}) => {
  const notes = [apr ? aprFootnote(aprRows) : null, parityNote(rows), longShare ? longShareNote(rows) : null].filter((note): note is string => !!note);
  return notes.length ? { notes } : {};
};

const requestedOf = (args: HeadlessPaneLoadArgs) => String(Array.isArray(args.argument) ? args.argument.join(" ") : args.argument ?? "").trim();
// No tab named: a market opens its history, nothing opens the board, as the pane does.
const tabOf = (args: HeadlessPaneLoadArgs) => PERP_TABS.find((tab) => tab === args.options.tab) ?? openingTab(requestedOf(args));
// A free account's market opens its latest values under the title, so the title names the function, not the Pro history: a table the free view
// locks is left out and named on the report's one Pro line (`lockedTable`), never marked on the title over the free ones.
const TITLES: Record<typeof PERP_TABS[number], string> = { board: "Perpetual markets", rankings: "Perpetual rankings", compare: "Perpetual contracts across venues",
  liquidations: "Perpetual liquidations across venues", depth: "Perpetual order book depth across venues", history: "Perpetuals", evidence: "Perpetual evidence" };
/** The days the liquidations read back from their time (`from` to `asOf`), as a heading names them: `7 days`; null without both. */
const windowDays = (data: Pick<PerpLiquidationsPayload, "from" | "asOf">) => {
  const days = Math.round((Date.parse(data.asOf) - Date.parse(data.from)) / 86_400_000);
  return Number.isFinite(days) && days > 0 ? `${days} ${days === 1 ? "day" : "days"}` : null;
};
const more = (count: number, noun: string) => `${count.toLocaleString("en-US")} more ${noun} need Gloom Pro`;
/**
 * A free board narrowed to one venue: how many of its markets free shows, or, where the preview holds none of its
 * markets, which venues the preview's are on. The rest is Pro; how many is not said, since a server that does not
 * filter by venue counts what it hides across every venue.
 */
function venuePreviewLine(venue: string, rows: readonly PerpBoardRow[], preview: readonly PerpBoardRow[]): string {
  const name = venueName(venue);
  if (rows.length) return `Free shows ${rows.length} ${name} market${rows.length === 1 ? "" : "s"}, its largest in each asset class; the rest need Gloom Pro`;
  const venues = venuesOf(preview).map(venueName);
  if (!venues.length) return `${name} markets need Gloom Pro`;
  return `The free preview's ${preview.length} markets are on ${venues.length > 1 ? `${venues.slice(0, -1).join(", ")} and ${venues.at(-1)}` : venues[0]}, none on ${name}; ${name} markets need Gloom Pro`;
}
// A table the free view leaves empty is locked: the report leaves it out and its one Pro line says what Pro adds.
const lockedTable = (locked: unknown) => locked ? { locked: true } : {};
// A free account's history line: what free shows of a market (its latest row, and the futures basis where CTM has
// a curve for the asset), then what Pro adds.
const historyLock = (selected: PerpBoardRow, venues: number | null) => {
  const base = selected.baseAsset.toUpperCase();
  const basis = basisSpotSymbol(base) ? ` (basis: fn CTM ${base})` : "";
  return freePreviewNote({ shows: `the latest funding, OI and premium${basis}`, adds: perpHistoryProText(selected, venues) });
};
// A venue filter the report cannot honour is said, not ignored.
const venueNotice = (venue: string, selected: PerpBoardRow, requested: string, access: string) => {
  if (venue === "all" || selected.venue === venue) return [];
  const [wanted, shown] = [venueName(venue), venueName(selected.venue)];
  return [IDENTITY_VENUES.some((id) => requested.startsWith(`${id}:`)) ? `${requested} is a ${shown} market, so the ${wanted} filter does not apply.`
    : `${wanted} has no ${selected.baseAsset} contract${access === "pro" ? "" : " in the free preview"}; showing ${shown}.`];
};
const venueUnused = (venue: string, tab: string) => venue === "all" ? [] : [`The ${venueName(venue)} filter applies to the board, not ${tab}; showing every venue.`];
const listMetadata = (data: Pick<PerpBoardPayload, "asOf" | "access" | "status"> & { locked: number | boolean }) => ({ asOf: data.asOf, access: data.access, locked: data.locked, status: data.status, rates: "fraction", oiCurrency: "USD" });

export const perpsHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "free-text", optional: true, placeholder: "market",
    description: "A base asset, underlying, canonical market identity or Market column label, such as BTC, hyperliquid:xyz:TSLA or xyz:TSLA. Opens its history; with --tab board it searches the board, with --tab compare, liquidations or depth it is the base asset. Without one, the board." },
  options: [
    { key: "tab", type: "enum", settingKey: "tab", values: PERP_TABS.map((value) => ({ value })), description: "Board, rankings, compare, liquidations, depth, history or evidence. Board without a market, history with one." },
    { key: "asset-class", type: "enum", settingKey: "assetClass", values: ASSET_FILTERS.map((value) => ({ value })), defaultValue: "all", description: "Board and rankings asset class." },
    { key: "venue", type: "enum", settingKey: "venue", values: ["all", ...VENUES].map((value) => ({ value })), defaultValue: "all", invalidValueHint: uncoveredVenueNote,
      description: "Board venue; with a market, opens that venue's contract when the board lists it." },
    { key: "sort", type: "enum", settingKey: "sort", values: BOARD_SORTS.map((value) => ({ value })), defaultValue: "oi", description: "Board order: open interest, funding, open-interest change, premium or long share of accounts." },
    { key: "days", type: "enum", settingKey: "days", values: ["1", "7", "30", "90", "365"].map((value) => ({ value })), defaultValue: "7", description: "History lookback in days." },
    { key: "metric", type: "enum", settingKey: "metric", values: HISTORY_METRICS.map((value) => ({ value })), defaultValue: "funding", description: "Displayed history chart; JSON retains every series." },
    { key: "limit", type: "integer", shot: REPORT_ROWS, minimum: 1, maximum: 5000, description: "Rows to list in each table, in its order: every row unless given.", example: "--limit 10" },
  ],
  discovery: { aliases: ["PERP"], dataRequirements: ["Perpetual market observations"], limitations: ["Free accounts see a fixed preview of the board, rankings and comparisons, and latest values for one market.", "Pro unlocks every market, full rankings and history.", "Rankings list up to ten markets each.", "Rates, premiums and changes are fractions in JSON.", "Open-interest history begins at first collection.", "Funding APR is a simple annualization, not a forecast.",
    "Long/short account shares: venue definitions differ; history begins at first collection.",
    "Liquidations come from each venue's public stream and begin at first collection: Binance and OKX send at most one a second per contract, Hyperliquid only its vault's backstop liquidations. Free shows totals and the three largest; Pro the hourly series and twenty.",
    "Order book depth is read hourly for each venue's 50 largest markets; a band wider than the book a venue returns is a floor (≥). Free shows the latest; Pro the week's history."] },
  describe: (args) => {
    const tab = tabOf(args), assetClass = String(args.options["asset-class"] ?? "all");
    // Rankings of one asset class say which in the title, as the board's filter does in its query.
    return tab === "rankings" && assetClass !== "all" ? `${label(assetClass)} perpetual rankings` : TITLES[tab];
  },
  async load(args, ctx) {
    const result = await loadPerpTab(args, ctx);
    // `--limit` lists the first rows of each table, in its own order.
    const limit = args.options.limit == null ? null : Number(args.options.limit);
    return limit == null ? result : { ...result, sections: result.sections.map((section) => section.rows ? { ...section, rows: section.rows.slice(0, limit) } : section) };
  },
};

/**
 * The asset's funding on every venue Compare lists, as one line: the APR range, the OI-weighted APR and any venue at
 * its 0.01%/8h baseline. JSON keeps each figure apart; nothing for an asset on one venue off its baseline.
 */
function acrossVenuesSection(rows: readonly PerpBoardRow[]): HeadlessBundleSection[] {
  const summary = venueAprSummary(rows);
  if (!summary) return [];
  const figure = (key: string, label: string, value: number | null) => ({ key, label, value, formatted: percent(value, 2) });
  return [{ title: "Across venues", entries: [figure("aprLow", "Lowest APR", summary.low), figure("aprHigh", "Highest APR", summary.high),
    figure("aprOiWeighted", "OI-weighted APR", summary.oiWeighted), { key: "contracts", label: "Contracts", value: summary.contracts },
    { key: "venues", label: "Venues", value: summary.venues }, { key: "baselineVenues", label: "At the 0.01%/8h baseline", value: summary.baseline, formatted: summary.baseline.join(", ") || "None" }],
  textEntries: [{ key: "apr", label: "APR", value: summary.text }] }];
}

/** One tab of PERP, every row the server sent. */
async function loadPerpTab(args: HeadlessPaneLoadArgs, ctx: HeadlessPaneContext): Promise<HeadlessBundleResult> {
  const requested = requestedOf(args);
  const tab = tabOf(args);
  if (tab === "board") {
    const assetClass = String(args.options["asset-class"] ?? "all"), venue = String(args.options.venue ?? "all"), sort = String(args.options.sort ?? "oi");
    const board = await fetchPerpsBoard({ ...(assetClass !== "all" ? { assetClass } : {}), ...(venue !== "all" ? { venue } : {}),
      ...(requested ? { search: boardSearchText(requested) } : {}), sort }, ctx.apiClient);
    // The server answers a venue with its own markets; a server that does not filter by venue answers every venue's.
    const rows = venue === "all" ? board.rows : board.rows.filter((row) => row.venue === venue);
    const lock = venue === "all" ? more(board.locked, "markets") : venuePreviewLine(venue, rows, board.rows);
    return { sections: [{ ...marketSection("Markets", BOARD_TEXT_COLUMNS, rows), ...lockedTable(board.locked && !rows.length) }], complete: !board.locked && board.status === "ok",
      errors: board.locked ? [lock] : [], ...aprNote(rows), freshness: perpFreshness(rows, { funding: rows, venue }),
      metadata: { ...listMetadata(board), total: board.total, assetClass, venue, sort, ...(requested ? { search: requested } : {}) } };
  }
  if (tab === "rankings") {
    const assetClass = String(args.options["asset-class"] ?? "all");
    const rankings = await fetchPerpsRankings(ctx.apiClient, assetClass);
    // A ranking the free view leaves empty is locked, left out and said on the Pro line; one that has none to rank says so.
    const sections: HeadlessBundleSection[] = RANKINGS.map((ranking) => {
      const rows = rankingRows(rankings, ranking.key);
      return { ...marketSection(ranking.label, rankingTextColumns(ranking), rows), ...lockedTable(rankings.locked && !rows.length) };
    });
    const notices = venueUnused(String(args.options.venue ?? "all"), "rankings");
    // Only the funding lists show funding.
    const funding = RANKINGS.filter((ranking) => ranking.field === "fundingRate8h").flatMap((ranking) => rankingRows(rankings, ranking.key));
    // The rankings show neither APR % nor Long %, only OI USD.
    const ranked = RANKINGS.flatMap((ranking) => rankingRows(rankings, ranking.key));
    return { sections, complete: !rankings.locked && rankings.status === "ok", errors: rankings.locked ? ["Full rankings need Gloom Pro"] : [],
      ...aprNote(ranked, { apr: false, longShare: false }),
      freshness: perpFreshness(RANKINGS.flatMap((ranking) => rankingRows(rankings, ranking.key)), { funding }), metadata: { ...(notices.length ? { notices } : {}), ...listMetadata(rankings), assetClass } };
  }
  if (tab === "compare") {
    // A canonical identity names one contract; its base asset is what the venues share.
    const identity = marketQuery(requested);
    const asked = identity.includes(":") ? (await fetchPerpSelection(identity, ctx.apiClient)).rows[0]?.baseAsset ?? identity : (requested || DEFAULT_MARKET).toUpperCase();
    // A pair or plain name (BTC-USD, bitcoin) compares the base asset it stands for; the rows say which.
    const compare = await fetchPerpsCompare(asked, ctx.apiClient);
    if (!compare.rows.length && !compare.locked) throw noMarket(requested || asked, await nearestPerpMarkets(requested || asked, ctx.apiClient));
    const base = compare.rows[0]?.baseAsset ?? asked;
    const spread = fundingSpread(compare.rows);
    const notices = [...(requested ? [] : [`Showing ${DEFAULT_MARKET}. Try fn PERP ${EXAMPLE_MARKETS[1]} --tab compare.`]),
      ...requested && !identity.includes(":") && base.toUpperCase() !== asked ? readAs(base, requested) : [], ...venueUnused(String(args.options.venue ?? "all"), "compare")];
    return { sections: [{ ...marketSection("Contracts", COMPARE_TEXT_COLUMNS, compare.rows), ...lockedTable(compare.locked) },
      ...(spread ? [{ title: "Funding spread", entries: [{ key: "fundingSpread8h", label: "Funding spread 8h", value: spread.value, formatted: `${spread.text} ${spread.detail}` }] }] : [])],
      complete: !compare.locked && compare.status === "ok", errors: compare.locked ? [more(compare.locked, compare.locked === 1 ? "contract" : "contracts")] : [],
      ...aprNote(compare.rows), freshness: perpFreshness(compare.rows, { funding: compare.rows }),
      metadata: { ...(requested ? {} : { defaultArgument: DEFAULT_MARKET }), ...(notices.length ? { notices } : {}),
        ...listMetadata(compare), total: compare.total, baseAsset: base,
        ...(spread ? { fundingSpread8h: spread.value, fundingSpreadHigh: spread.high.marketId, fundingSpreadLow: spread.low.marketId } : {}) } };
  }
  if (tab === "liquidations" || tab === "depth") {
    // A canonical identity names one contract; its base asset is what the venues share. A pair or plain name reads as its base asset.
    const identity = marketQuery(requested);
    const asked = identity.includes(":") ? (await fetchPerpSelection(identity, ctx.apiClient)).rows[0]?.baseAsset ?? identity : (requested || DEFAULT_MARKET).toUpperCase();
    const notices = (base: string) => [...(requested ? [] : [`Showing ${DEFAULT_MARKET}. Try fn PERP ${EXAMPLE_MARKETS[1]} --tab ${tab}.`]),
      ...requested && !identity.includes(":") && base.toUpperCase() !== asked ? readAs(base, requested) : [], ...venueUnused(String(args.options.venue ?? "all"), tab)];
    if (tab === "liquidations") {
      const data = await fetchPerpsLiquidations(asked, ctx.apiClient);
      if (!data.markets.length && data.status !== "unavailable") throw noMarket(requested || asked, await nearestPerpMarkets(requested || asked, ctx.apiClient));
      const told = notices(data.baseAsset);
      const locked = lockedTable(data.locked);
      const entries = (["long24h", "short24h", "long7d", "short7d"] as const).map((key) => ({ key, label: `${key.startsWith("long") ? "Longs" : "Shorts"} liquidated ${key.endsWith("24h") ? "24h" : "7d"}`,
        value: data.totals[key], formatted: `${compact(data.totals[key])} USD` }));
      return { sections: [{ title: "Totals", entries: [...entries, { key: "collectingSince", label: "Collecting since", value: data.collectingSince, formatted: time(data.collectingSince) }] },
        { title: "By contract", columns: LIQUIDATION_TEXT_COLUMNS, rows: data.markets.map((row) => ({ ...row })) },
        { title: "Hourly", columns: HOURLY_COLUMNS, rows: data.hourly.map((row) => ({ ...row })), ...locked },
        // The prints are the window's, not the 24 hours beside them: the heading says which.
        { title: "Largest prints", textTitle: windowDays(data) ? `Largest prints, ${windowDays(data)}` : "Largest prints", columns: printTextColumns(data.baseAsset), rows: data.largest.map((row) => ({ ...row })) }],
        complete: !data.locked && data.status === "ok" && !downStreams(data).length, notes: data.notes,
        errors: data.locked ? [freePreviewNote({ shows: "liquidation totals and the three largest prints", adds: "the hourly series and the twenty largest prints" })] : [],
        freshness: liquidationFreshness(data),
        metadata: { ...(requested ? {} : { defaultArgument: DEFAULT_MARKET }), ...(told.length ? { notices: told } : {}), baseAsset: data.baseAsset, asOf: data.asOf, from: data.from,
          access: data.access, locked: data.locked, status: data.status, collectingSince: data.collectingSince, streams: data.streams, notionalCurrency: "USD" } };
    }
    const data = await fetchPerpsDepth(asked, ctx.apiClient);
    if (!data.rows.length && data.status !== "unavailable") throw noMarket(requested || asked, await nearestPerpMarkets(requested || asked, ctx.apiClient));
    const told = notices(data.baseAsset);
    const staleNote = depthStaleNote(data.rows);
    // The band totals over the current books, as the tab's figures show them; a floor (≥) when a book ends inside the band.
    const bands = depthBandTotals(data.rows).map((band) => ({ key: `band${band.key}`, label: band.label, value: band.bids + band.asks,
      formatted: `${band.floor ? "≥" : ""}${compact(band.bids + band.asks)} USD (bids ${compact(band.bids)} · asks ${compact(band.asks)}, ${band.books} ${band.books === 1 ? "book" : "books"})` }));
    return { sections: [...bands.length ? [{ title: "Band totals", entries: bands }] : [],
      { title: "Order books", columns: DEPTH_TEXT_COLUMNS, rows: data.rows.map((row) => ({ ...row })) },
      { title: "Hourly depth", columns: DEPTH_HISTORY_COLUMNS, rows: data.history.map((row) => ({ ...row })), ...lockedTable(data.locked) }],
      complete: !data.locked && data.status === "ok" && !staleNote, notes: [...staleNote ? [staleNote] : [], ...data.notes],
      errors: data.locked ? [freePreviewNote({ shows: "each book's latest depth", adds: "the week's hourly depth" })] : [],
      freshness: depthFreshness(data),
      metadata: { ...(requested ? {} : { defaultArgument: DEFAULT_MARKET }), ...(told.length ? { notices: told } : {}), baseAsset: data.baseAsset, asOf: data.asOf,
        access: data.access, locked: data.locked, status: data.status, sources: data.sources, notionalCurrency: "USD", reach: "fraction of mid" } };
  }
  const search = requested || DEFAULT_MARKET, venue = String(args.options.venue ?? "all");
  const market = await fetchPerpSelection(search, ctx.apiClient, venue !== "all" ? venue : undefined, true);
  const selected = market.rows[0];
  if (!selected) throw noMarket(search, market.suggestions);
  const notices = [...(requested ? [] : [`Showing ${DEFAULT_MARKET}. Try fn PERP ${EXAMPLE_MARKETS[1]}.`]),
    ...market.resolved ? readAs(marketLabel(selected), requested, market.resolved.others) : [], ...venueNotice(venue, selected, requested, market.access)];
  const metadata = { ...(requested ? {} : { defaultArgument: DEFAULT_MARKET }), ...(notices.length ? { notices } : {}), marketId: selected.marketId, sourceUrl: selected.sourceUrl, observedAt: selected.observedAt, sourceAsOf: selected.sourceAsOf,
    rates: "fraction", quoteCurrency: selected.quoteCurrency, oiCurrency: "USD", fundingIntervalHours: selected.fundingIntervalHours };
  // The venue's market as last polled, with the funding its latest row shows.
  const freshness = perpFreshness([selected], { funding: [selected] });
  // The same Positioning lines the pane's Evidence shows; JSON keeps the raw reading on the market row.
  const positioning = positioningFields(selected);
  // One line under the market for the asset on every venue: the carry another venue pays is the first thing to check.
  const venues = acrossVenuesSection(market.venues ?? []);
  const aprRows = venues.length ? [selected, ...market.venues ?? []] : [selected];
  if (tab === "evidence") return {
    sections: [marketSection("Market evidence", MARKET_COLUMNS, market.rows), ...venues,
      // Where the figures were read, as the pane's Evidence names it: the venue's own endpoint and its time.
      { title: "Source", entries: [{ key: "sourceUrl", label: "URL", value: selected.sourceUrl },
        { key: "sourceAsOf", label: "Venue as of", value: selected.sourceAsOf, formatted: time(selected.sourceAsOf) }] },
      ...(positioning ? [{ title: "Positioning", entries: positioning.map((field) => ({ key: field.key, label: field.label, value: field.value,
        formatted: field.detail ? `${field.text} · ${field.detail}` : field.text })) }] : []),
      { title: "Observation revisions", columns: REVISION_COLUMNS, rows: market.evidence.map((row) => ({ ...row })), ...lockedTable(market.access !== "pro") }],
    // Positioning dates the long share itself.
    complete: market.access === "pro" && market.status === "ok", ...aprNote(market.rows, { longShare: false, aprRows }), freshness,
    errors: market.access !== "pro" ? [freePreviewNote({ shows: `${marketLabel(selected)}'s latest evidence and positioning`, adds: "its observation revisions" })] : [],
    metadata: { ...metadata, asOf: market.asOf, access: market.access, locked: market.locked, status: market.status },
  };
  const history = await fetchPerpsHistory({ marketId: selected.marketId, from: new Date(Date.now() - Number(args.options.days ?? 7) * 86_400_000).toISOString(), resolution: "auto", limit: 5000 }, ctx.apiClient);
  const locked = lockedTable(history.locked);
  return { sections: [marketSection("Latest market", MARKET_COLUMNS, [selected]), ...venues, { title: "Own observations", columns: observationColumns(selected.quoteCurrency), rows: history.rows.map((row) => ({ ...row })), ...locked },
    { title: "Paid funding", columns: FUNDING_COLUMNS, rows: history.funding.map((row) => ({ ...row })), ...locked }, { title: "Hourly candles", columns: candleColumns(selected.quoteCurrency), rows: history.candles.map((row) => ({ ...row })), ...locked },
    { title: "Long/short history", columns: LONG_SHORT_COLUMNS, rows: (history.longShortRatio ?? []).map((row) => ({ ...row })), ...locked }],
    complete: !history.locked && !history.truncated && history.status === "ok", ...aprNote([selected], { aprRows }), freshness,
    errors: history.locked ? [historyLock(selected, collectedVenueCount(market.sources))] : history.truncated ? ["History reached the 5,000-observation limit; narrow the range"] : [],
    metadata: { ...metadata, asOf: history.asOf, access: history.access, locked: history.locked, status: history.status, from: history.from, to: history.to, resolution: history.resolution, truncated: history.truncated ?? false },
  };
}
