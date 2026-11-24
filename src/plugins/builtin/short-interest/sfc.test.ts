import { expect, test } from "bun:test";
import { sfcEmpty, sfcReport, sfcSymbol } from "./sfc";
import type { HeadlessPaneLoadArgs } from "../../../types/headless";
const sample = { symbol:"0700",exchange:"HKEX" as const,source:"Hong Kong SFC",page:"https://www.sfc.hk/",reportsReviewed:2,newestReport:"2026-11-13",
  points:["2026-11-13","2026-11-06"].map(day=>({ day,name:"TENCENT",shares:56894634,valueHkd:21995465504,observedAt:"2026-11-24T00:00:00Z",sourceModifiedAt:null,sourceUrl:"https://www.sfc.hk/report.csv" })) };
test("only Hong Kong's local counter reads SFC positions", () => {
  expect(["700:HKEX","0700.HK","00700:XHKG"].map(key=>sfcSymbol(key))).toEqual(["0700","0700","0700"]);
  expect(sfcSymbol("80700","HKEX")).toBe("80700");
  for (const other of ["700", "TCEHY", "0700:JPX","TCEHY:OTC"]) expect(sfcSymbol(other)).toBeNull();
});
test("weekly rows preserve their SFC values, documents and requested ordering",()=>{
  const args: HeadlessPaneLoadArgs = {rawArgument:"0700:HKEX",argument:"0700:HKEX",symbols:["0700:HKEX"],options:{order:"oldest",limit:1}};
  expect(sfcReport(sample,args).rows).toEqual([sample.points[1]!]);
  expect(sfcEmpty({...sample,reportsReviewed:0},"2026-11-10")).toContain("No SFC file was observed by 2026-11-10");
});
