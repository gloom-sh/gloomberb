import { expect, test } from "bun:test";
import { followsUsBondMarket, usBondMarketClosedNote, usBondMarketHoliday } from "./us-bond-market";

test("a day the US bond market was shut names its holiday, and a curve or rate asked for it says which day it shows", () => {
  expect(usBondMarketClosedNote("2026-11-11", "2026-11-10")).toBe("Wed 11 Nov: US bond market closed (Veterans Day); showing Tue 10 Nov");
  expect(usBondMarketClosedNote("2026-11-07", "2026-11-06")).toBe("Sat 7 Nov: weekend; showing Fri 6 Nov");
  // A trading day with no curve yet, or a gap a closure does not explain, says nothing.
  expect(usBondMarketClosedNote("2026-11-12", "2026-11-10")).toBeNull();
  expect(usBondMarketClosedNote("2026-11-10", "2026-11-10")).toBeNull();
  // Columbus Day and Good Friday close bonds, but not a Good Friday the March jobs report comes out on (an early close:
  // DGS10 has 2026-04-03, 2023-04-07, 2021-04-02); a Saturday Veterans Day closes nothing (the market traded Fri 10 Nov
  // 2023), while a Saturday Independence Day closes the Friday; Juneteenth only from 2022.
  expect(["2026-10-12", "2024-03-29", "2025-04-18", "2026-04-03", "2023-04-07", "2021-04-02", "2015-04-03", "2012-04-06", "2010-04-02"]
    .map(usBondMarketHoliday)).toEqual(["Columbus Day", "Good Friday", "Good Friday", null, null, null, null, null, null]);
  expect(["2023-11-10", "2020-07-03", "2021-06-18", "2022-06-20"].map(usBondMarketHoliday))
    .toEqual([null, "Independence Day", null, "Juneteenth"]);
  expect(["DGS10", "T10Y2Y", "DTB3", "SOFR", "SP500", "DCOILWTICO"].map(followsUsBondMarket)).toEqual([true, true, true, true, false, false]);
});
