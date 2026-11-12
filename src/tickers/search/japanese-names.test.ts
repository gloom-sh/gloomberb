import { expect, test } from "bun:test";
import { japaneseNameReadAs, readJapaneseName } from "./japanese-names";

test("a name typed in Japanese reads as the listings it names: a market's word, a company's whole name, or the companies it starts", async () => {
  // `search トヨタ` and `search ドル円` said "No matches": listings are named in Latin letters.
  expect(await readJapaneseName("ドル円")).toEqual([{ key: "USDJPY=X", name: "ドル円" }]);
  expect((await readJapaneseName("日経平均"))[0]!.key).toBe("^N225");
  expect((await readJapaneseName("金"))[0]!.key).toBe("GC=F");
  expect(await readJapaneseName("トヨタ自動車")).toEqual([{ key: "7203:JPX", name: "トヨタ自動車" }]);
  // Typed with a middle dot, it is the same name.
  expect((await readJapaneseName("ソニー・グループ")).map(({ key }) => key)).toEqual(["6758:JPX"]);
  // The start of several names lists them, the major company first.
  const toyota = await readJapaneseName("トヨタ");
  expect(toyota.map(({ key }) => key).slice(0, 2)).toEqual(["7203:JPX", "3116:JPX"]);
  expect(japaneseNameReadAs("トヨタ", toyota.slice(0, 2))).toBe('Read "トヨタ" as 7203:JPX (トヨタ自動車), 3116:JPX (トヨタ紡織).');
  // Latin letters, and words no name holds, read as nothing here.
  expect(await readJapaneseName("Toyota")).toEqual([]);
  expect(await readJapaneseName("存在しない会社名")).toEqual([]);
});
