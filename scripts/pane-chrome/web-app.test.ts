import { expect, test } from "bun:test";
import { unversionedRead } from "./web-app";

test("a read that asks for a payload version is found as the snapshot kept it without one, every other parameter as written", () => {
  expect(unversionedRead("GET /api/cloud/debt-maturities?symbol=AAPL&version=2\n")).toBe("GET /api/cloud/debt-maturities?symbol=AAPL\n");
  expect(unversionedRead("GET /api/cloud/debt-maturities?symbol=0019&exchange=HKEX&name=Swire+Pacific+Limited&version=2\n"))
    .toBe("GET /api/cloud/debt-maturities?symbol=0019&exchange=HKEX&name=Swire+Pacific+Limited\n");
  expect(unversionedRead("GET /api/x?version=2\n")).toBe("GET /api/x\n");
  expect(unversionedRead("POST /api/market/quote/batch?version=3\n{\"a\":1}")).toBe("POST /api/market/quote/batch\n{\"a\":1}");
  // Nothing to drop: no other read is tried.
  expect(unversionedRead("GET /api/cloud/debt-maturities?symbol=AAPL\n")).toBeNull();
  expect(unversionedRead("GET /api/apps?versions=2&app_version=2\n")).toBeNull();
  expect(unversionedRead("GET /api/status\n")).toBeNull();
});
