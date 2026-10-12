import { expect, test } from "bun:test";
import { describeCollections, findNamedCollection } from "./collection-name";

const portfolios = [
  { id: "main", name: "Main Portfolio" },
  { id: "family", name: "Family" },
  // Another portfolio's name never shadows an id typed exactly.
  { id: "kids", name: "main" },
];

test("a portfolio argument matches its id or its name, trimmed and in any case", () => {
  for (const typed of ["Family", "family", "FAMILY", "  family ", "fAmIlY"]) {
    expect(findNamedCollection(portfolios, typed)?.id).toBe("family");
  }
  expect(findNamedCollection(portfolios, "main portfolio")?.id).toBe("main");
  expect(findNamedCollection(portfolios, "main")?.id).toBe("main");
  expect(findNamedCollection(portfolios, "Kids")?.id).toBe("kids");
  expect(findNamedCollection(portfolios, "default")).toBeNull();
  expect(findNamedCollection(portfolios, "  ")).toBeNull();
  expect(describeCollections(portfolios.slice(0, 2))).toBe("Main Portfolio (main), Family (family)");
});
