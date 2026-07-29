import { describe, expect, test } from "bun:test";
import { getRouterEntityKey } from "./cache";
import { makeRouterRequestIdentity } from "./routing";

const deps = { getEntityKey: getRouterEntityKey };

describe("router request identity", () => {
  test("uses the same canonical variant for cache and revalidation identity", () => {
    const identity = makeRouterRequestIdentity(deps, {
      kind: "options-chain",
      ticker: "aapl",
      variantParts: [["exchange", "NASDAQ"], ["expiration", 1_800_000_000]],
    });

    expect(identity).toEqual({
      kind: "options-chain",
      entityKey: "AAPL",
      variantKey: "exchange=NASDAQ;expiration=1800000000",
      revalidationKey: "options-chain|AAPL|exchange=NASDAQ;expiration=1800000000",
    });
  });

  test("does not collapse concurrent exchange variants", () => {
    const nasdaq = makeRouterRequestIdentity(deps, {
      kind: "holders",
      ticker: "shop",
      variantParts: [["exchange", "NASDAQ"]],
    });
    const tsx = makeRouterRequestIdentity(deps, {
      kind: "holders",
      ticker: "shop",
      variantParts: [["exchange", "TSX"]],
    });

    expect(nasdaq.entityKey).toBe(tsx.entityKey);
    expect(nasdaq.variantKey).not.toBe(tsx.variantKey);
    expect(nasdaq.revalidationKey).not.toBe(tsx.revalidationKey);
  });
});
