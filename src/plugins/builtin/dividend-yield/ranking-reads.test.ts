import { expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import type { DividendData } from "./client";
import { readDividendRanking } from "./ranking-reads";

const data = { payments: [], currency: "USD" } as unknown as DividendData;
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("every ranking, fn's, shot's and each pane's alike, reads at most four tickers at once and the first 25 of a list", async () => {
  let inFlight = 0;
  let most = 0;
  const waiting: Array<() => void> = [];
  const started: string[] = [];
  const reads = {
    loadData: async (symbol: string) => {
      started.push(symbol);
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise<void>((resolve) => waiting.push(resolve));
      inFlight -= 1;
      return data;
    },
  };
  const long = readDividendRanking(Array.from({ length: 30 }, (_, index) => `T${index}`), reads);
  const pane = readDividendRanking(["KO", "JNJ"], reads);
  await settle();
  // Two rankings at once share the four.
  expect(started).toEqual(["T0", "T1", "T2", "T3"]);
  while (waiting.length > 0) {
    waiting.splice(0).forEach((release) => release());
    await settle();
  }
  expect(most).toBe(4);
  expect((await long).map((entry) => entry.symbol)).toHaveLength(25);
  expect((await pane).map((entry) => "data" in entry)).toEqual([true, true]);
  expect(started).toHaveLength(27);
});

test("a read Gloom Cloud rate limits is asked once more after the wait it names; a second refusal leaves the row not read", async () => {
  const tries = new Map<string, number>();
  const waits: number[] = [];
  const limited = () => new ApiRequestError("Too many requests", 429, 250);
  const entries = await readDividendRanking(["KO", "JNJ", "PEP"], {
    loadData: async (symbol) => {
      const count = (tries.get(symbol) ?? 0) + 1;
      tries.set(symbol, count);
      if (symbol === "KO" && count === 1) throw limited();
      if (symbol === "JNJ") throw limited();
      if (symbol === "PEP") throw new ApiRequestError("Not found", 404);
      return data;
    },
  }, { sleep: async (ms) => { waits.push(ms); } });
  expect(entries.map((entry) => "data" in entry ? "read" : entry.error)).toEqual(["read", "Too many requests", "Not found"]);
  // Once more each, and only for a 429.
  expect(Object.fromEntries(tries)).toEqual({ KO: 2, JNJ: 2, PEP: 1 });
  expect(waits).toEqual([250, 250]);
});
