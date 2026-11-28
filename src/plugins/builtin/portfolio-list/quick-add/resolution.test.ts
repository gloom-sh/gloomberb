import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { getSharedRegistry, setSharedRegistryForTests, type PluginRegistry } from "../../../registry";
import { createTestDataProvider, createTestQuote } from "../../../../test-support/data-provider";
import type { InstrumentSearchResult } from "../../../../types/instrument";
import {
  createQuickAddListMemo,
  mayBeQuickAddList,
  normalizeQuickAddQuery,
  QUICK_ADD_REFUSAL,
  readQuickAddEntries,
  resolveQuickAddList,
  resolveQuickAddValidation,
} from "./resolution";

const collection = { collectionId: "collection", tickers: new Map(), financials: new Map() };
const listings = [
  { symbol: "600519", exchange: "SSE", name: "Kweichow Moutai", searchAliases: ["贵州茅台"] },
  { symbol: "0700", exchange: "HKEX", name: "Tencent Holdings", searchAliases: ["腾讯控股"] },
  { symbol: "7974", exchange: "JPX", name: "Nintendo" },
  { symbol: "005930", exchange: "KRX", name: "Samsung Electronics", searchAliases: ["삼성전자"] },
  { symbol: "GAZP", exchange: "MOEX", name: "Газпром" },
  { symbol: "NESN", exchange: "SIX", name: "Nestle S.A." },
  { symbol: "AAPL", exchange: "NASDAQ", name: "Apple Inc." },
];

const search = mock(async (query: string): Promise<InstrumentSearchResult[]> => listings
  .filter(({ symbol, exchange, name, searchAliases }) => [symbol, `${symbol}:${exchange}`, name.split(" ")[0], ...searchAliases ?? []].includes(query))
  .map((listing) => ({ ...listing, providerId: "test", type: "stock" })));
const getQuote = mock(async (symbol: string, exchange?: string) => createTestQuote({ symbol, exchangeName: exchange }));
const marketData = createTestDataProvider({ search, getQuote });
let previousRegistry: PluginRegistry | undefined;

beforeEach(() => {
  previousRegistry = getSharedRegistry();
  setSharedRegistryForTests({ marketData } as PluginRegistry);
  search.mockClear();
  getQuote.mockClear();
});

afterEach(() => setSharedRegistryForTests(previousRegistry));

test.each([
  ["贵州茅台", "600519", "SSE"],
  ["任天堂", "7974", "JPX"],
  ["삼성전자", "005930", "KRX"],
  ["Газпром", "GAZP", "MOEX"],
  ["Nestle\u0301", "NESN", "SIX"],
  ["＄ＡＡＰＬ", "AAPL", "NASDAQ"],
  ["６００５１９", "600519", "SSE"],
])("quick-add resolves %s as %s on %s", async (typed, symbol, exchange) => {
  expect(mayBeQuickAddList(typed)).toBe(false);
  const query = normalizeQuickAddQuery(typed);
  for (const collectionKind of ["watchlist", "portfolio"] as const) {
    expect(await resolveQuickAddValidation({ ...collection, collectionKind, query })).toMatchObject({
      status: "ready",
      symbol,
      resolved: { kind: "provider", result: { exchange } },
    });
  }
});

test("an ambiguous Japanese name offers the matching listings without trying to quote the name", async () => {
  const result = await resolveQuickAddValidation({ ...collection, collectionKind: "watchlist", query: "トヨタ" });
  expect(result).toMatchObject({ status: "choose", listings: expect.arrayContaining([{ key: "7203:JPX", name: "トヨタ自動車" }]) });
  expect(getQuote).not.toHaveBeenCalled();
});

test.each(["watchlist", "portfolio"] as const)("quick-add reads and memoizes native names in a %s paste", async (collectionKind) => {
  const memo = createQuickAddListMemo();
  const resolvePaste = async (value: string) => resolveQuickAddList({
    ...collection, collectionKind, memo, query: normalizeQuickAddQuery(value), ...await readQuickAddEntries(value, memo),
  });
  const paste = "贵州茅台， 腾讯控股, ＡＡＰＬ";
  expect(mayBeQuickAddList("贵州茅台，腾讯控股")).toBe(true);
  const ready = [
    { status: "ready", symbol: "600519" },
    { status: "ready", symbol: "0700" },
    { status: "ready", symbol: "AAPL" },
  ];
  expect(await resolvePaste(paste)).toMatchObject({ status: "list", entries: ready });
  search.mockClear();
  expect(await resolvePaste(`${paste}, 💥`)).toMatchObject({
    status: "list",
    entries: [...ready, { status: "missing", query: "💥", message: QUICK_ADD_REFUSAL }],
  });
  expect(search).not.toHaveBeenCalled();
});

test("junk is refused locally, but an unknown name is checked", async () => {
  const validate = (query: string) => resolveQuickAddValidation({ ...collection, collectionKind: "watchlist", query });
  expect(await validate("贵州💥")).toMatchObject({ status: "missing", message: QUICK_ADD_REFUSAL });
  expect(search).not.toHaveBeenCalled();
  expect(await validate("不存在的公司")).toMatchObject({ status: "missing", message: "No exact ticker match" });
  expect(search).toHaveBeenCalled();
});
