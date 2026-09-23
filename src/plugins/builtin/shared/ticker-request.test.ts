import { expect, test } from "bun:test";
import { tapeRejection } from "../time-sales/client";
import { listingIdentity } from "./ticker-request";

test("a listing key splits into the bare symbol and its exchange", () => {
  expect(listingIdentity("AMD:XNAS")).toEqual({ symbol: "AMD", exchange: "NASDAQ" });
  expect(listingIdentity("spy:arcx", "NYSEARCA")).toEqual({ symbol: "SPY", exchange: "ARCA" });
  expect(listingIdentity("AMD", "NASDAQ")).toEqual({ symbol: "AMD", exchange: "NASDAQ" });
  expect(listingIdentity("BRK.B")).toEqual({ symbol: "BRK.B", exchange: "" });
  expect(listingIdentity("  ")).toBeNull();
  expect(listingIdentity(null)).toBeNull();
});

test("a rejected tape request shows its stated reason", () => {
  expect(tapeRejection('{"symbol":"AMD:XNAS","status":"unavailable","gaps":["A US equity symbol is required"]}')).toBe("A US equity symbol is required");
  expect(tapeRejection("Bad Gateway")).toBeNull();
  expect(tapeRejection('{"gaps":[]}')).toBeNull();
});
