import { expect, test } from "bun:test";
import { isKanjiOnlyName, japaneseNameChoice, japaneseNameReadAs, readExactJapaneseName, readJapaneseName } from "./japanese-names";

const keys = async (typed: string) => (await readJapaneseName(typed))?.listings.map(({ key }) => key) ?? [];

test("a name with kana reads as the Tokyo listings it names: its whole name, the companies it starts, then those it is within", async () => {
  // `search トヨタ` and `search ドル円` said "No matches": listings are named in Latin letters.
  expect(await readJapaneseName("ドル円")).toEqual({ listings: [{ key: "USDJPY=X", name: "ドル円" }], total: 1, match: "market" });
  expect(await keys("日経平均")).toEqual(["^N225"]);
  expect(await keys("金")).toEqual(["GC=F"]);
  expect(await keys("トヨタ自動車")).toEqual(["7203:JPX"]);
  // Typed with a middle dot, it is the same name.
  expect(await keys("ソニー・グループ")).toEqual(["6758:JPX"]);
  // The start of several names lists them, the major company first.
  const toyota = (await readJapaneseName("トヨタ"))!;
  expect(toyota.listings.map(({ key }) => key)).toEqual(["7203:JPX", "3116:JPX"]);
  expect(japaneseNameReadAs("トヨタ", toyota)).toBe('Read "トヨタ" as 7203:JPX (トヨタ自動車), 3116:JPX (トヨタ紡織).');
  expect(japaneseNameChoice("トヨタ", toyota)).toBe("2 companies start with トヨタ. Listings: 7203:JPX (トヨタ自動車), 3116:JPX (トヨタ紡織).");
  // A word many names hold says how many in all, not the five it lists.
  const held = (await readJapaneseName("ホールディングス"))!;
  expect(held.listings).toHaveLength(5);
  expect(held.total).toBeGreaterThan(400);
  expect(japaneseNameChoice("ホールディングス", held)).toStartWith(`${held.total} companies' names hold ホールディングス. The first 5: `);
  // Latin letters, and words no name holds, read as nothing here.
  expect(await readJapaneseName("Toyota")).toBeNull();
  expect(await readJapaneseName("ソニー存在しない")).toBeNull();
});

// `quote 中電` was Chudenko (1941:JPX), whose name starts with it; it is CLP's short name in Hong Kong.
test("a name in kanji alone is left to the service, and read from the Tokyo list only as a company's whole name", async () => {
  for (const chinese of ["中電", "東亞", "中国"]) {
    expect(isKanjiOnlyName(chinese)).toBe(true);
    expect(await readJapaneseName(chinese)).toBeNull();
    expect(await readExactJapaneseName(chinese)).toBeNull();
  }
  expect((await readExactJapaneseName("中電工"))?.listings).toEqual([{ key: "1941:JPX", name: "中電工" }]);
  expect((await readExactJapaneseName("任天堂"))?.listings.map(({ key }) => key)).toEqual(["7974:JPX"]);
  // A market's word in kanji is still its listing; kana goes to the list.
  expect(isKanjiOnlyName("金")).toBe(false);
  expect(isKanjiOnlyName("トヨタ")).toBe(false);
  expect(await readExactJapaneseName("トヨタ自動車")).toBeNull();
});
