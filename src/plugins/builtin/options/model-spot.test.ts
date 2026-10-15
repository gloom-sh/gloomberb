import { expect, test } from "bun:test";
import type { Quote } from "../../../types/financials";
import { modelSpotLabel, optionModelSpot } from "./model-spot";
import { chainOpenInterestAsOf, openInterestAsOfLabel, statedOpenInterestAsOf } from "./open-interest-as-of";

// KO before Tuesday's open: Monday's chain from the close, a pre-market print, Monday's official close.
const chainAsOf = "2026-10-12T19:59:59.998Z";
const preMarket: Quote = { symbol: "KO", price: 90.65, currency: "USD", change: 0.86, changePercent: 0.96, lastUpdated: Date.parse("2026-10-13T12:21:44Z"),
  marketState: "PRE", extendedSessionPrint: true, regularClose: 89.79, regularCloseSessionDate: "2026-10-12" };
const tuesdayMorning = Date.parse("2026-10-13T12:41:00Z");

test("a chain from the close is valued at that close and the chain's time, not at a later print", () => {
  const spot = optionModelSpot(preMarket, { asOf: chainAsOf }, tuesdayMorning, "NYSE")!;
  expect(spot).toEqual({ price: 89.79, observedAt: Date.parse("2026-10-12T20:00:00Z"), valuationTime: Date.parse(chainAsOf),
    basis: "close", session: null });
  expect(modelSpotLabel(spot)).toBe("close Mon 12 Oct 20:00 UTC");
  // The same holds after Tuesday's open while the delayed chain still quotes Monday's close.
  const open = { ...preMarket, price: 90.4, marketState: "REGULAR" as const, extendedSessionPrint: undefined };
  expect(optionModelSpot(open, { asOf: chainAsOf }, Date.parse("2026-10-13T13:40:00Z"), "NYSE")?.price).toBe(89.79);
});

test("a chain quoted in the session is valued at the latest price, named with its session and time", () => {
  const session = { ...preMarket, price: 90.4, marketState: "REGULAR" as const, extendedSessionPrint: undefined, lastUpdated: Date.parse("2026-10-13T15:00:00Z") };
  const now = Date.parse("2026-10-13T15:05:00Z");
  const spot = optionModelSpot(session, { asOf: "2026-10-13T15:04:30Z" }, now, "NYSE")!;
  expect([spot.price, spot.basis, spot.valuationTime]).toEqual([90.4, "last", now]);
  expect(modelSpotLabel(spot)).toBe("last Tue 13 Oct 15:00 UTC");
  // A quote that carries no close for the chain's session keeps its print, and says which session it is from.
  const noClose = optionModelSpot({ ...preMarket, regularClose: undefined }, { asOf: chainAsOf }, tuesdayMorning, "NYSE")!;
  expect([noClose.price, noClose.valuationTime, modelSpotLabel(noClose)]).toEqual([90.65, Date.parse(chainAsOf), "pre-market Tue 13 Oct 12:21 UTC"]);
  expect(optionModelSpot({ ...preMarket, stale: true }, { asOf: chainAsOf }, tuesdayMorning)).toBeNull();
});

test("the chain's open interest takes OPX's date only when every count agrees", () => {
  const contract = (strike: number, openInterest?: number) => ({ strike, openInterest });
  const chain = { calls: [contract(85, 4199), contract(90, 9400)], puts: [contract(85, 5025), contract(90)] };
  const listed = (put85: number) => ({ oiDate: "2026-10-09", strikes: [
    { strike: 85, callOI: 4199, putOI: put85, callChange: null, putChange: null, payout: null },
    { strike: 90, callOI: 9400, putOI: 2064, callChange: null, putChange: null, payout: null },
  ] });
  const agreed = chainOpenInterestAsOf(chain as never, listed(5025));
  expect(agreed).toEqual({ date: "2026-10-09", listedDate: "2026-10-09", compared: 3, matched: 3 });
  expect(openInterestAsOfLabel(agreed)).toBe("OI as of Fri 9 Oct");
  // One count from another session leaves the date unstated rather than borrowed.
  const apart = chainOpenInterestAsOf(chain as never, listed(4815));
  expect(apart).toEqual({ date: null, listedDate: "2026-10-09", compared: 3, matched: 2 });
  expect(openInterestAsOfLabel(apart)).toBe("OI date not published");
});

test("a chain's own open-interest date is used as stated; only a chain without the field is compared with OPX", () => {
  expect(openInterestAsOfLabel(statedOpenInterestAsOf({ openInterestAsOf: "2026-10-09" })!)).toBe("OI as of Fri 9 Oct");
  expect(openInterestAsOfLabel(statedOpenInterestAsOf({ openInterestAsOf: null })!)).toBe("OI date not published");
  // An older server sends no field, and an unreadable value is no statement either.
  expect(statedOpenInterestAsOf({})).toBeUndefined();
  expect(statedOpenInterestAsOf({ openInterestAsOf: "9 Oct" })).toBeUndefined();
});
