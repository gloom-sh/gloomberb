import { afterEach, expect, test } from "bun:test";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { attachIpoCalendarPersistence, getCachedIpoCalendar, loadIpoCalendar, resetIpoCalendarPersistence } from "./cache";
import type { IpoCalendarFetchResult } from "./client";

afterEach(resetIpoCalendarPersistence);

test("concurrent IPO loads retain partial errors, persist dates, and preserve the board on an empty refresh", async () => {
  const persistence = new MemoryPluginPersistence();
  attachIpoCalendarPersistence(persistence);
  const records = [{ ticker: "TEST", companyName: "Test", date: new Date("2026-09-01T00:00:00Z"), status: "priced" as const,
    exchange: null, offerSize: null, priceRange: null, pricedPrice: 10, shares: null, closePrice: null, change1D: null }];
  let finish!: (result: IpoCalendarFetchResult) => void;
  const pending = new Promise<IpoCalendarFetchResult>((resolve) => { finish = resolve; });
  const first = loadIpoCalendar(false, () => pending);
  const second = loadIpoCalendar(false, async () => { throw new Error("must share request"); });
  finish({ records, errors: ["upcoming endpoint failed"] });
  expect((await first).errors).toEqual(["upcoming endpoint failed"]);
  expect((await second).errors).toEqual(["upcoming endpoint failed"]);
  resetIpoCalendarPersistence();
  attachIpoCalendarPersistence(persistence);
  expect(getCachedIpoCalendar()?.records[0]?.date).toBeInstanceOf(Date);
  const fallback = await loadIpoCalendar(true, async () => ({ records: [], errors: ["upcoming failed", "priced failed"] }));
  expect(fallback.records[0]?.ticker).toBe("TEST");
  expect(fallback.stale).toBe(true);
  expect(fallback.errors).toEqual(["upcoming failed", "priced failed"]);
});
