import { afterEach, expect, setSystemTime, test } from "bun:test";
import { isRegularSessionTime, latestRegularSessionClose, nextRegularSessionOpen } from "../../market-data/market/freshness";
import type { PricePoint } from "../../types/financials";
import { fallbackProvider } from "../../test-support/data-provider";
import { AssetDataRouter } from "./index";

// The Muscat Stock Exchange (UTC+4, no daylight time) trades Sunday to
// Thursday since 1 Jun 2026: continuous 10:00 to 14:45, the closing auction to
// 14:55 and trade at last to 15:00. Gloom Cloud's five-minute bars of a
// session, built from its trades, run from 10:00 to 14:55.

afterEach(() => { setSystemTime(); });

const at = (local: string) => Date.parse(`${local}:00+04:00`);

test("the Muscat Stock Exchange trades Sunday to Thursday and closes at 15:00", () => {
  // [now, in session, latest close]
  const rows: Array<[string, boolean, string]> = [
    ["2026-10-09T12:00", false, "2026-10-08T11:00:00.000Z"],
    ["2026-10-10T12:00", false, "2026-10-08T11:00:00.000Z"],
    ["2026-10-11T09:59", false, "2026-10-08T11:00:00.000Z"],
    ["2026-10-11T11:00", true, "2026-10-08T11:00:00.000Z"],
    ["2026-10-06T14:59", true, "2026-10-05T11:00:00.000Z"],
    ["2026-10-06T15:00", false, "2026-10-06T11:00:00.000Z"],
    // National Day, Wednesday and Thursday 25 and 26 Nov 2026: Tuesday's session holds to Sunday.
    ["2026-11-26T12:00", false, "2026-11-24T11:00:00.000Z"],
  ];
  for (const [now, inSession, close] of rows) {
    expect(isRegularSessionTime("MSX", at(now)), now).toBe(inSession);
    expect(new Date(latestRegularSessionClose("MSX", at(now))!.close).toISOString(), now).toBe(close);
  }
  expect(new Date(nextRegularSessionOpen("MSX", at("2026-10-10T12:00"))!.open).toISOString()).toBe("2026-10-11T06:00:00.000Z");
});

/** Five-minute bars of one local day, from 10:00 to `last`. */
function bars(date: string, last = "14:55"): PricePoint[] {
  const points: PricePoint[] = [];
  for (let time = at(`${date}T10:00`); time <= at(`${date}T${last}`); time += 5 * 60_000) {
    points.push({ date: new Date(time), close: 0.443, volume: 1_000 });
  }
  return points;
}

/** [what, now, the day the bars are from, their last bar, served]; times are Muscat's. */
const ROWS: Array<[string, string, string, string, boolean]> = [
  ["Friday, Thursday's session", "2026-10-09T12:00", "2026-10-08", "14:55", true],
  ["Saturday, Thursday's session", "2026-10-10T12:00", "2026-10-08", "14:55", true],
  ["Saturday, Wednesday's session: Thursday is missing", "2026-10-10T12:00", "2026-10-07", "14:55", false],
  ["Sunday before the open, Thursday's session", "2026-10-11T09:30", "2026-10-08", "14:55", true],
  ["Sunday in session, today's bars so far", "2026-10-11T11:30", "2026-10-11", "11:10", true],
  ["Sunday in session, bars that stopped at 10:30", "2026-10-11T12:00", "2026-10-11", "10:30", false],
  ["Tuesday after the close", "2026-10-06T16:00", "2026-10-06", "14:55", true],
  ["Tuesday after the close, a thin listing's fresh copy ending at noon", "2026-10-06T16:00", "2026-10-06", "12:00", true],
];

test.each(["BKMB.OM", "BKMB:MSX"])("%s one-day history is current through its week", async (symbol) => {
  for (const [what, now, date, last, served] of ROWS) {
    setSystemTime(new Date(at(now)));
    const points = bars(date, last);
    const asked: string[] = [];
    const router = new AssetDataRouter({
      ...fallbackProvider,
      async getPriceHistory(_ticker, exchange) { asked.push(exchange); return points; },
    }, []);
    const answer = router.getPriceHistoryWithMetadata(symbol, "", "1D").then((value) => value.points.length, () => 0);
    expect(await answer, `${symbol}: ${what}`).toBe(served ? points.length : 0);
    expect(asked, `${symbol}: ${what}`).toEqual(["MSX"]);
  }
});
