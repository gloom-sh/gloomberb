import { expect, test } from "bun:test";
import { createTestDataProvider } from "../../test-support/data-provider";
import { AssetDataRouter } from "./index";

test("the router knows a symbol to be a US stock when one of its sources does", () => {
  const knowing = new AssetDataRouter(createTestDataProvider({ id: "knows", knownUsStock: (symbol) => symbol === "V" }));
  expect(knowing.knownUsStock("V")).toBe(true);
  expect(knowing.knownUsStock("QWZXQ")).toBe(false);
  expect(new AssetDataRouter(createTestDataProvider({ id: "silent" })).knownUsStock("V")).toBe(false);
});
