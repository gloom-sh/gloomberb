import { expect, test } from "bun:test";
import { jpxSymbol } from "./jpx";

test("only Tokyo stock codes route to JPX disclosures, including alphanumeric codes and terminal aliases", () => {
  for (const key of ["285A:JPX", "285A.T", "285A.T:TSEJ"]) expect(jpxSymbol(key)).toBe("285A");
  expect(jpxSymbol("7974", "JPX")).toBe("7974");
  for (const key of ["7974", "7974:HKEX", "7974.T:NASDAQ", "NTDOY", "7974.TW:JPX"]) expect(jpxSymbol(key)).toBeNull();
});
