import { expect, test } from "bun:test";
import { describeCollections, findNamedCollection, unknownCollectionArgError } from "./collection-name";

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

test("where a pane or report opens one, the start of a single collection's name opens it, and a shared start asks for more", () => {
  const books = [
    { id: "main", name: "Main Portfolio" },
    { id: "a1b2", name: "Family Office" },
    { id: "c3d4", name: "Family Trust" },
    { id: "e5f6", name: "Retirement" },
  ];
  // `PF ret` is Retirement; a command that changes a collection still takes its whole name.
  expect(findNamedCollection(books, "ret", { prefix: true })?.name).toBe("Retirement");
  expect(findNamedCollection(books, "ret")).toBeNull();
  expect(findNamedCollection(books, "family office", { prefix: true })?.id).toBe("a1b2");
  // Two collections start "family": neither opens, and the bar names both.
  expect(findNamedCollection(books, "family", { prefix: true })).toBeNull();
  expect(unknownCollectionArgError("family", books, "portfolio or watchlist", undefined, { prefix: true }))
    .toEqual({ message: '"family" starts more than one portfolio or watchlist', detail: "Type more of Family Office or Family Trust" });
  expect(unknownCollectionArgError("family o", books, "portfolio or watchlist", undefined, { prefix: true })).toBeNull();
});
