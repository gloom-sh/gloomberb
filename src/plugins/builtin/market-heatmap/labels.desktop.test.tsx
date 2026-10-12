/** @jsxImportSource react */
import { expect, test } from "bun:test";
import {
  buildHeatTreemapScene,
  formatHeatTileMove,
  heatTreemapCanvas,
  HeatTreemapSurface,
  type MetricTreemapItem,
} from "../../../components/metric-treemap";
import { createDomTestHarness } from "../../../renderers/dom/test-utils";

const dom = createDomTestHarness();

/** The 20 largest names as a recent snapshot had them: market cap in $B, sector, industry. */
const HEAD: Array<[string, number, string, string]> = [
  ["NVDA", 5538, "Technology", "Semiconductors"],
  ["AAPL", 4968, "Technology", "Consumer Electronics"],
  ["GOOGL", 4300, "Communication Services", "Internet Content & Information"],
  ["GOOG", 4255, "Communication Services", "Internet Content & Information"],
  ["MSFT", 3973, "Technology", "Software - Infrastructure"],
  ["AMZN", 2832, "Consumer Cyclical", "Internet Retail"],
  ["TSM", 2351, "Technology", "Semiconductors"],
  ["SPCX", 2142, "Industrials", "Aerospace & Defense"],
  ["META", 1829, "Communication Services", "Internet Content & Information"],
  ["AVGO", 1726, "Technology", "Semiconductors"],
  ["TSLA", 1511, "Consumer Cyclical", "Auto Manufacturers"],
  ["SKHY", 1212, "Technology", "Semiconductors"],
  ["MU", 1162, "Technology", "Semiconductors"],
  ["BRK.B", 1103, "Financial Services", "Insurance - Diversified"],
  ["LLY", 1052, "Healthcare", "Drug Manufacturers - General"],
  ["AMD", 993, "Technology", "Semiconductors"],
  ["JPM", 887, "Financial Services", "Banks - Diversified"],
  ["WMT", 884, "Consumer Defensive", "Discount Stores"],
  ["V", 724, "Financial Services", "Credit Services"],
  ["XOM", 694, "Energy", "Oil & Gas Integrated"],
];

/** Where the other 480 fall, with about as many names in each as the real board has. */
const TAIL: Array<[string, string, number]> = [
  ["Technology", "Semiconductors", 14], ["Technology", "Software - Infrastructure", 18], ["Technology", "Software - Application", 19],
  ["Technology", "Computer Hardware", 8], ["Technology", "Communication Equipment", 8], ["Technology", "Semiconductor Equipment & Materials", 7],
  ["Financial Services", "Banks - Regional", 16], ["Financial Services", "Banks - Diversified", 11], ["Financial Services", "Asset Management", 12],
  ["Financial Services", "Capital Markets", 7], ["Financial Services", "Credit Services", 6], ["Financial Services", "Insurance - Property & Casualty", 7],
  ["Industrials", "Aerospace & Defense", 14], ["Industrials", "Specialty Industrial Machinery", 13], ["Industrials", "Railroads", 5],
  ["Healthcare", "Drug Manufacturers - General", 11], ["Healthcare", "Diagnostics & Research", 12], ["Healthcare", "Biotechnology", 11],
  ["Healthcare", "Medical Devices", 7], ["Consumer Cyclical", "Internet Retail", 7], ["Consumer Cyclical", "Restaurants", 6],
  ["Consumer Cyclical", "Auto Manufacturers", 5], ["Energy", "Oil & Gas Midstream", 11], ["Energy", "Oil & Gas E&P", 7],
  ["Energy", "Oil & Gas Integrated", 7], ["Consumer Defensive", "Household & Personal Products", 7], ["Consumer Defensive", "Discount Stores", 3],
  ["Communication Services", "Entertainment", 10], ["Communication Services", "Internet Content & Information", 3],
  ["Communication Services", "Telecom Services", 5], ["Utilities", "Utilities - Regulated Electric", 18],
  ["Basic Materials", "Specialty Chemicals", 6], ["Real Estate", "REIT - Specialty", 5],
];

/**
 * US Stocks as the pane lays it out (square root of market cap, sector, then
 * industry): the head above, then 480 names falling from $690B to $21B with
 * one- to five-letter tickers. Deterministic.
 */
function usStocksBoard(): Array<MetricTreemapItem<null>> {
  const names = HEAD.map(([symbol, cap, sector, industry]) => ({ symbol, cap: cap * 1e9, sector, industry }));
  const slots = TAIL.flatMap(([sector, industry, count]) => Array.from({ length: count }, () => [sector, industry] as const));
  const used = new Set(names.map((name) => name.symbol));
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let rank = HEAD.length; rank < 500; rank += 1) {
    const [sector, industry] = slots[Math.floor(random() * slots.length)]!;
    const length = rank % 50 === 7 ? 1 : [3, 4, 3, 2, 4, 3, 4, 4, 5, 3][rank % 10]!;
    let symbol = "";
    do symbol = Array.from({ length }, () => String.fromCharCode(65 + Math.floor(random() * 26))).join("");
    while (used.has(symbol));
    used.add(symbol);
    names.push({ symbol, cap: 690e9 * (21 / 690) ** ((rank - HEAD.length) / (499 - HEAD.length)), sector, industry });
  }
  return names.map((name, rank) => ({
    id: name.symbol,
    label: name.symbol,
    weight: Math.sqrt(name.cap),
    group: name.sector,
    subgroup: name.industry,
    primaryText: formatHeatTileMove(Math.sin(rank * 1.7) * 2.5),
    data: null,
  }));
}

// The pane of the report (600 by 234 px) and the default floating pane.
for (const [columns, rows] of [[75, 13], [110, 35]] as const) {
  test(`a ${columns}x${rows} desktop pane labels the largest names, and no blank tile is as big as a labelled one`, async () => {
    const board = usStocksBoard();
    const scene = buildHeatTreemapScene(board, heatTreemapCanvas(columns, rows, { nativePaneChrome: true, cellWidthPx: 8, cellHeightPx: 18 }));
    const container = await dom.render(
      <HeatTreemapSurface scene={scene} items={board} width={columns} height={rows} selectedId={null} onSelect={() => {}} />,
    );
    const text = [...container.querySelectorAll("[data-gloom-role='heat-tile']")].map((tile) => tile.textContent ?? "");
    expect(text).toHaveLength(scene.tiles.length);
    const tiles = scene.tiles.map((tile, index) => ({
      ticker: tile.item.label,
      width: tile.width,
      height: tile.height,
      labelled: text[index]!.includes(tile.item.label),
    }));
    const labelled = new Set(tiles.filter((tile) => tile.labelled).map((tile) => tile.ticker));

    expect(HEAD.slice(0, 10).map(([symbol]) => symbol).filter((symbol) => !labelled.has(symbol))).toEqual([]);
    // As it stands, or for a tall tile turned on its side: the layout's choice of
    // which way a tile stands must not decide whether it is labelled.
    const covers = (big: typeof tiles[number], small: typeof tiles[number]) =>
      (big.width >= small.width && big.height >= small.height)
      || (big.height > big.width && big.height >= small.width && big.width >= small.height);
    const blankBesideLabelled = tiles
      .filter((tile) => !tile.labelled)
      .flatMap((blank) => {
        const smaller = tiles.find((tile) => tile.labelled && tile.ticker.length >= blank.ticker.length && covers(blank, tile));
        return smaller ? [`${blank.ticker} blank, ${smaller.ticker} labelled`] : [];
      });
    expect(blankBesideLabelled).toEqual([]);
  });
}
