import { expect, test } from "bun:test";
import { sgxVolumeSymbol } from "./sgx";

test("SGX short volume resolves the home listing without capturing US symbols or a different venue", () => {
  expect(sgxVolumeSymbol("D05:SGX")).toBe("D05");
  expect(sgxVolumeSymbol("Z74.SI")).toBe("Z74");
  expect(sgxVolumeSymbol("O39", "SGX")).toBe("O39");
  expect(sgxVolumeSymbol("D05")).toBeNull();
  expect(sgxVolumeSymbol("D05.SI", "HKEX")).toBeNull();
  expect(sgxVolumeSymbol("D05:NYSE")).toBeNull();
});
