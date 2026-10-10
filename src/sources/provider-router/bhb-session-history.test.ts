import { afterEach, expect, setSystemTime, test } from "bun:test";
import { isRegularSessionTime, latestRegularSessionClose, nextRegularSessionOpen } from "../../market-data/market/freshness";
import type { PricePoint } from "../../types/financials";
import { fallbackProvider } from "../../test-support/data-provider";
import { AssetDataRouter } from "./index";

// Bahrain Bourse (UTC+3, no daylight time) trades Sunday to Thursday,
// continuously 09:30 to 13:00 with no closing auction. Gloom Cloud's
// five-minute bars of a session, built from its trades, end with its 12:55 bar.

afterEach(() => { setSystemTime(); });

const at = (local: string) => Date.parse(`${local}:00+03:00`);

test("Bahrain Bourse trades Sunday to Thursday and closes at 13:00", () => {
  // [now, in session, latest close]
  const rows: Array<[string, boolean, string]> = [
    ["2026-10-09T12:00", false, "2026-10-08T10:00:00.000Z"],
    ["2026-10-10T12:00", false, "2026-10-08T10:00:00.000Z"],
    ["2026-10-11T09:29", false, "2026-10-08T10:00:00.000Z"],
    ["2026-10-11T10:00", true, "2026-10-08T10:00:00.000Z"],
    ["2026-10-06T12:59", true, "2026-10-05T10:00:00.000Z"],
    ["2026-10-06T13:00", false, "2026-10-06T10:00:00.000Z"],
    // National Day, Wednesday and Thursday 16 and 17 Dec 2026: Tuesday's session holds to Sunday.
    ["2026-12-17T12:00", false, "2026-12-15T10:00:00.000Z"],
  ];
  for (const [now, inSession, close] of rows) {
    expect(isRegularSessionTime("BHB", at(now)), now).toBe(inSession);
    expect(new Date(latestRegularSessionClose("BHB", at(now))!.close).toISOString(), now).toBe(close);
  }
  expect(new Date(nextRegularSessionOpen("BHB", at("2026-10-10T12:00"))!.open).toISOString()).toBe("2026-10-11T06:30:00.000Z");
});

/** Five-minute bars of one local day, from 09:30 to `last`. */
function bars(date: string, last = "12:55"): PricePoint[] {
  const points: PricePoint[] = [];
  for (let time = at(`${date}T09:30`); time <= at(`${date}T${last}`); time += 5 * 60_000) {
    points.push({ date: new Date(time), close: 0.806, volume: 1_000 });
  }
  return points;
}

/** [what, now, the day the bars are from, their last bar, served]; times are Bahrain's. */
const ROWS: Array<[string, string, string, string, boolean]> = [
  ["Friday, Thursday's session", "2026-10-09T12:00", "2026-10-08", "12:55", true],
  ["Saturday, Thursday's session", "2026-10-10T12:00", "2026-10-08", "12:55", true],
  ["Saturday, Wednesday's session: Thursday is missing", "2026-10-10T12:00", "2026-10-07", "12:55", false],
  ["Sunday before the open, Thursday's session", "2026-10-11T09:20", "2026-10-08", "12:55", true],
  ["Sunday in session, today's bars so far", "2026-10-11T11:00", "2026-10-11", "10:40", true],
  ["Sunday in session, bars that stopped at 10:00", "2026-10-11T11:30", "2026-10-11", "10:00", false],
  ["Tuesday after the close", "2026-10-06T14:00", "2026-10-06", "12:55", true],
  ["Tuesday after the close, a copy that stopped at 11:00", "2026-10-06T14:00", "2026-10-06", "11:00", false],
];

test.each(["ALBH.BH", "ALBH:BHB"])("%s one-day history is current through its week", async (symbol) => {
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
    expect(asked, `${symbol}: ${what}`).toEqual(["BHB"]);
  }
});
