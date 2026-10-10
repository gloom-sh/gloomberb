import { afterEach, expect, setSystemTime, test } from "bun:test";
import type { PricePoint } from "../../types/financials";
import { fallbackProvider } from "../../test-support/data-provider";
import { AssetDataRouter } from "./index";

// One-day history of Gulf listings between sessions, asked the way the CLI
// asks: no exchange, the venue read off the symbol. Riyadh and Doha are UTC+3
// and Dubai UTC+4, with no daylight time. Tadawul and Qatar trade Sunday to
// Thursday, DFM Monday to Friday. Gloom Cloud's five-minute copies run from
// 10:00 to 14:55 in Riyadh, 09:30 to 13:10 in Doha and 10:00 to 14:55 in Dubai.

const VENUES = {
  TADAWUL: { offset: "+03:00", first: "10:00", last: "14:55" },
  QE: { offset: "+03:00", first: "09:30", last: "13:10" },
  DFM: { offset: "+04:00", first: "10:00", last: "14:55" },
} as const;
type Venue = keyof typeof VENUES;

const SYMBOLS: Array<[string, Venue]> = [
  ["1120.SR", "TADAWUL"], ["^TASI.SR", "TADAWUL"], ["2222:TADAWUL", "TADAWUL"], ["QNBK:QE", "QE"], ["EMAAR:DFM", "DFM"],
];

/** [what, now, the day the bars are from, their last bar (the full session when null), served]; times are local to the venue. */
type Row = [string, string, string, string | null, boolean];

const ROWS: Record<Venue, Row[]> = {
  TADAWUL: [
    ["Friday, Thursday's session", "2026-10-09T12:00", "2026-10-08", null, true],
    ["Saturday, Thursday's session", "2026-10-10T12:00", "2026-10-08", null, true],
    ["Saturday, Wednesday's session: Thursday is missing", "2026-10-10T12:00", "2026-10-07", null, false],
    ["Sunday before the open, Thursday's session", "2026-10-11T09:00", "2026-10-08", null, true],
    ["Sunday in session, today's bars so far", "2026-10-11T12:00", "2026-10-11", "11:40", true],
    ["Sunday in session, bars that stopped at 10:30", "2026-10-11T12:00", "2026-10-11", "10:30", false],
    ["Tuesday after the close", "2026-10-06T16:00", "2026-10-06", null, true],
    ["Tuesday after the close, a copy that stopped at noon", "2026-10-06T16:00", "2026-10-06", "12:00", false],
  ],
  QE: [
    ["Friday, Thursday's session", "2026-10-09T12:00", "2026-10-08", null, true],
    ["Saturday, Thursday's session", "2026-10-10T12:00", "2026-10-08", null, true],
    ["Saturday, Wednesday's session: Thursday is missing", "2026-10-10T12:00", "2026-10-07", null, false],
    ["Sunday before the open, Thursday's session", "2026-10-11T09:00", "2026-10-08", null, true],
    ["Sunday in session, today's bars so far", "2026-10-11T11:00", "2026-10-11", "10:40", true],
    ["Sunday in session, bars that stopped at 10:00", "2026-10-11T11:30", "2026-10-11", "10:00", false],
    ["Tuesday after the close", "2026-10-06T14:00", "2026-10-06", null, true],
    ["Tuesday after the close, a copy that stopped at 11:00", "2026-10-06T14:00", "2026-10-06", "11:00", false],
  ],
  DFM: [
    ["Saturday, Friday's session", "2026-10-10T12:00", "2026-10-09", null, true],
    ["Saturday, Thursday's session: Friday is missing", "2026-10-10T12:00", "2026-10-08", null, false],
    ["Sunday, closed, Friday's session", "2026-10-11T12:00", "2026-10-09", null, true],
    ["Monday before the open, Friday's session", "2026-10-12T09:00", "2026-10-09", null, true],
    ["Tuesday after the close", "2026-10-06T16:00", "2026-10-06", null, true],
    ["Tuesday after the close, a copy that stopped at noon", "2026-10-06T16:00", "2026-10-06", "12:00", false],
  ],
};

/** Five-minute bars of one local day, from the venue's first bar to `last`. */
function bars(venue: Venue, date: string, last: string): PricePoint[] {
  const { offset, first } = VENUES[venue];
  const start = Date.parse(`${date}T${first}:00${offset}`);
  const end = Date.parse(`${date}T${last}:00${offset}`);
  const points: PricePoint[] = [];
  for (let time = start; time <= end; time += 5 * 60_000) points.push({ date: new Date(time), close: 100, volume: 1_000 });
  return points;
}

afterEach(() => { setSystemTime(); });

test.each(SYMBOLS)("%s one-day history is current through its venue's week", async (symbol, venue) => {
  const { offset } = VENUES[venue];
  for (const [what, now, date, last, served] of ROWS[venue]) {
    setSystemTime(new Date(`${now}:00${offset}`));
    const points = bars(venue, date, last ?? VENUES[venue].last);
    const asked: string[] = [];
    const router = new AssetDataRouter({
      ...fallbackProvider,
      async getPriceHistory(_ticker, exchange) { asked.push(exchange); return points; },
    }, []);
    const answer = router.getPriceHistoryWithMetadata(symbol, "", "1D").then((value) => value.points.length, () => 0);
    expect(await answer, `${symbol}: ${what}`).toBe(served ? points.length : 0);
    expect(asked, `${symbol}: ${what}`).toEqual([venue]);
  }
});
