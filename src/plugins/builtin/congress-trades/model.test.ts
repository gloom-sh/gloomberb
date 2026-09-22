import { describe, expect, test } from "bun:test";
import type { CloudCongressHousePayload } from "../../../api-client";
import {
  canLoadMoreCongress,
  congressScanNotice,
  mergeCongressPages,
  nextCongressPage,
  previousCongressYearPage,
} from "./model";

function payload(overrides: Partial<CloudCongressHousePayload> = {}): CloudCongressHousePayload {
  return {
    asOf: "2026-01-01T00:00:00.000Z",
    chamber: "house",
    source: "house-clerk",
    year: 2026,
    indexUpdatedAt: null,
    filingsScanned: 20,
    filingCount: 80,
    filingOffset: 0,
    hasMore: false,
    hasMoreFilings: true,
    nextOffset: 20,
    nextFilingOffset: 20,
    trades: [],
    members: [],
    ...overrides,
  };
}

describe("congress paging", () => {
  test("walks remaining trades, then more filings, then stops", () => {
    expect(nextCongressPage(payload({ hasMore: true, nextOffset: 40 }))).toEqual({
      year: 2026,
      offset: 40,
      filingOffset: 0,
    });
    expect(nextCongressPage(payload({ hasMore: false, hasMoreFilings: true, nextFilingOffset: 20 }))).toEqual({
      year: 2026,
      offset: 0,
      filingOffset: 20,
    });
    expect(nextCongressPage(payload({
      hasMore: false,
      hasMoreFilings: undefined,
      filingOffset: 0,
      filingsScanned: 20,
      filingCount: 80,
    }))).toEqual({
      year: 2026,
      offset: 0,
      filingOffset: 20,
    });
  });

  test("never crosses into an earlier year on its own", () => {
    // Each earlier year is a fresh set of source documents to read.
    expect(nextCongressPage(payload({ hasMore: false, hasMoreFilings: false }))).toBeNull();
    expect(canLoadMoreCongress(payload({ hasMore: false, hasMoreFilings: false }))).toBe(false);
    // A filtered filing window can be empty while a later window has matches.
    expect(nextCongressPage(mergeCongressPages(payload(), payload({
      filingOffset: 20, nextFilingOffset: 40, trades: [],
    })))).toEqual({ year: 2026, offset: 0, filingOffset: 40 });
  });

  test("offers the earlier year only when asked, and only back to 2008", () => {
    expect(previousCongressYearPage(payload({ year: 2026 }))).toEqual({
      year: 2025,
      offset: 0,
      filingOffset: 0,
    });
    expect(previousCongressYearPage(payload({ year: 2008 }))).toBeNull();
  });

  test("names the filings missing from an incomplete window", () => {
    expect(congressScanNotice(payload())).toBeNull();
    expect(congressScanNotice(payload({ filingsFailed: 2 }))).toBe("2 filings unavailable");
    expect(congressScanNotice(payload({ filingsFailed: 1, filingsPending: 3 }))).toBe(
      "4 filings not read yet, retrying later",
    );
  });

  test("appends unique trades and members from the next page", () => {
    const merged = mergeCongressPages(
      payload({
        trades: [{ id: "t1" } as CloudCongressHousePayload["trades"][number]],
        members: [{ id: "m1" } as CloudCongressHousePayload["members"][number]],
      }),
      payload({
        year: 2025,
        trades: [
          { id: "t1" } as CloudCongressHousePayload["trades"][number],
          { id: "t2" } as CloudCongressHousePayload["trades"][number],
        ],
        members: [{ id: "m2" } as CloudCongressHousePayload["members"][number]],
      }),
    );
    expect(merged.year).toBe(2025);
    expect(merged.trades.map((trade) => trade.id)).toEqual(["t1", "t2"]);
    expect(merged.members.map((member) => member.id)).toEqual(["m1", "m2"]);
  });
});
