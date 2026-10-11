import { expect, test } from "bun:test";
import { isRegularSessionTime, latestRegularSessionClose, latestRegularSessionOpen, nextRegularSessionOpen, regularSessionCloseUtcMinute } from "./freshness";

const at = (iso: string) => Date.parse(iso);
const iso = (time: number | null | undefined) => (time == null ? null : new Date(time).toISOString());

test("TASE's Friday session closes at 13:50, the other weekdays at 17:30, whatever the clock offset", () => {
  // Summer time (UTC+3): Thursday 8 October and Friday 9 October.
  expect(iso(latestRegularSessionClose("TASE", at("2026-10-08T20:00:00Z"))?.close)).toBe("2026-10-08T14:30:00.000Z");
  expect(iso(latestRegularSessionClose("TASE", at("2026-10-09T20:00:00Z"))?.close)).toBe("2026-10-09T10:50:00.000Z");
  // Before Friday's close the latest one is still Thursday's, and over the weekend Friday's.
  expect(latestRegularSessionClose("TASE", at("2026-10-09T10:49:00Z"))?.date).toBe("2026-10-08");
  expect(latestRegularSessionClose("TASE", at("2026-10-11T12:00:00Z"))?.date).toBe("2026-10-09");
  // Winter time (UTC+2).
  expect(iso(latestRegularSessionClose("TASE", at("2026-12-04T20:00:00Z"))?.close)).toBe("2026-12-04T11:50:00.000Z");
  expect(regularSessionCloseUtcMinute("TASE", at("2026-12-04T20:00:00Z"))).toBe(11 * 60 + 50);
  expect(regularSessionCloseUtcMinute("TASE", at("2026-12-03T20:00:00Z"))).toBe(15 * 60 + 30);
  // Another venue keeps one close on Fridays.
  expect(iso(latestRegularSessionClose("EPA", at("2026-10-09T20:00:00Z"))?.close)).toBe("2026-10-09T15:40:00.000Z");
});

test("TASE's session state follows its Friday close", () => {
  // Friday opens at 09:59 (06:59Z) and ends at 10:50Z; Thursday ends at 14:30Z.
  expect(isRegularSessionTime("TASE", at("2026-10-09T06:58:00Z"))).toBe(false);
  expect(isRegularSessionTime("TASE", at("2026-10-09T06:59:00Z"))).toBe(true);
  expect(isRegularSessionTime("TASE", at("2026-10-09T10:49:00Z"))).toBe(true);
  expect(isRegularSessionTime("TASE", at("2026-10-09T10:50:00Z"))).toBe(false);
  expect(isRegularSessionTime("TASE", at("2026-10-08T14:29:00Z"))).toBe(true);
  expect(isRegularSessionTime("TASE", at("2026-10-08T14:30:00Z"))).toBe(false);
  // Over the weekend the latest open is still Friday's.
  expect(iso(latestRegularSessionOpen("TASE", at("2026-10-11T12:00:00Z")))).toBe("2026-10-09T06:59:00.000Z");
});

test("Tadawul and Qatar trade Sunday to Thursday, DFM Monday to Friday", () => {
  // Riyadh and Doha are UTC+3, Dubai UTC+4. Closes include the closing
  // auction and trading at last: 15:20 in Riyadh, 13:15 in Doha, 15:00 in Dubai.
  // [venue, now, in session, latest close]
  const rows: Array<[string, string, boolean, string]> = [
    // Friday at noon: Tadawul and Qatar are off, DFM trades.
    ["TADAWUL", "2026-10-09T09:00:00Z", false, "2026-10-08T12:20:00.000Z"],
    ["QE", "2026-10-09T09:00:00Z", false, "2026-10-08T10:15:00.000Z"],
    ["DFM", "2026-10-09T08:00:00Z", true, "2026-10-08T11:00:00.000Z"],
    // Saturday: all closed, on Thursday's session and DFM's Friday one.
    ["TADAWUL", "2026-10-10T09:00:00Z", false, "2026-10-08T12:20:00.000Z"],
    ["QE", "2026-10-10T09:00:00Z", false, "2026-10-08T10:15:00.000Z"],
    ["DFM", "2026-10-10T08:00:00Z", false, "2026-10-09T11:00:00.000Z"],
    // Sunday a minute before Tadawul opens, then at noon: Tadawul and Qatar trade, DFM is off.
    ["TADAWUL", "2026-10-11T06:59:00Z", false, "2026-10-08T12:20:00.000Z"],
    ["TADAWUL", "2026-10-11T09:00:00Z", true, "2026-10-08T12:20:00.000Z"],
    ["QE", "2026-10-11T09:00:00Z", true, "2026-10-08T10:15:00.000Z"],
    ["DFM", "2026-10-11T08:00:00Z", false, "2026-10-09T11:00:00.000Z"],
    // A Tuesday session ends after trading at last.
    ["TADAWUL", "2026-10-06T12:19:00Z", true, "2026-10-05T12:20:00.000Z"],
    ["TADAWUL", "2026-10-06T12:20:00Z", false, "2026-10-06T12:20:00.000Z"],
    ["QE", "2026-10-06T10:15:00Z", false, "2026-10-06T10:15:00.000Z"],
    ["DFM", "2026-10-06T11:00:00Z", false, "2026-10-06T11:00:00.000Z"],
  ];
  for (const [venue, now, inSession, close] of rows) {
    expect(isRegularSessionTime(venue, at(now)), `${venue} ${now}`).toBe(inSession);
    expect(iso(latestRegularSessionClose(venue, at(now))?.close), `${venue} ${now}`).toBe(close);
  }
  // Saturday's next session is Sunday's in Riyadh and Monday's in Dubai.
  expect(iso(nextRegularSessionOpen("TADAWUL", at("2026-10-10T09:00:00Z"))?.open)).toBe("2026-10-11T07:00:00.000Z");
  expect(iso(nextRegularSessionOpen("DFM", at("2026-10-10T08:00:00Z"))?.open)).toBe("2026-10-12T06:00:00.000Z");
});

test("Boursa Kuwait trades Sunday to Thursday and closes with its auction", () => {
  // Kuwait is UTC+3. Continuous trading opens 09:00; the close is the end of
  // the closing auction, 13:10 (10:10 UTC).
  // [now, in session, latest close]
  const rows: Array<[string, boolean, string]> = [
    // Friday and Saturday are off, on Thursday's session.
    ["2026-10-09T09:00:00Z", false, "2026-10-08T10:10:00.000Z"],
    ["2026-10-10T09:00:00Z", false, "2026-10-08T10:10:00.000Z"],
    // Sunday a minute before the open, then at 11:00 Kuwait.
    ["2026-10-11T05:59:00Z", false, "2026-10-08T10:10:00.000Z"],
    ["2026-10-11T08:00:00Z", true, "2026-10-08T10:10:00.000Z"],
    // A Tuesday session through the closing auction.
    ["2026-10-06T10:09:00Z", true, "2026-10-05T10:10:00.000Z"],
    ["2026-10-06T10:10:00Z", false, "2026-10-06T10:10:00.000Z"],
  ];
  for (const [now, inSession, close] of rows) {
    expect(isRegularSessionTime("KUWAIT", at(now)), now).toBe(inSession);
    expect(iso(latestRegularSessionClose("KUWAIT", at(now))?.close), now).toBe(close);
  }
  expect(iso(nextRegularSessionOpen("KUWAIT", at("2026-10-10T09:00:00Z"))?.open)).toBe("2026-10-11T06:00:00.000Z");
});
