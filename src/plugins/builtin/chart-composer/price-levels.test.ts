import { expect, test } from "bun:test";
import { DEFAULT_LEVEL_COLOR, editPriceLevels, parsePriceLevels, priceLevelTickerKey } from "./price-levels";

test("levels are kept per listing, survive a damaged entry and leave no empty listings behind", () => {
  const stored = parsePriceLevels({
    "NVDA:XNAS": [{ id: "a", price: 230.5, color: "#4c9aff" }, { id: "", price: 1 }, { id: "b", price: "x" }],
    "AMD:XNAS": "not a list",
  });
  expect(stored).toEqual({ "NVDA:XNAS": [{ id: "a", price: 230.5, color: "#4c9aff" }] });

  const added = editPriceLevels(stored, "NVDA:XNAS", { kind: "add", id: "c", price: 225 });
  expect(added["NVDA:XNAS"]).toEqual([
    { id: "a", price: 230.5, color: "#4c9aff" },
    { id: "c", price: 225, color: DEFAULT_LEVEL_COLOR },
  ]);
  expect(editPriceLevels(added, "NVDA:XNAS", { kind: "add", id: "d", price: 225 })).toBe(added);
  const moved = editPriceLevels(added, "NVDA:XNAS", { kind: "move", id: "a", price: 231 });
  expect(moved["NVDA:XNAS"]![0]!.price).toBe(231);
  const emptied = editPriceLevels(
    editPriceLevels(moved, "NVDA:XNAS", { kind: "remove", id: "a" }),
    "NVDA:XNAS",
    { kind: "remove", id: "c" },
  );
  expect(emptied).toEqual({});
});

test("every chart of a listing agrees on its key, and a generic's ignores venue, roll and adjustment", () => {
  expect(priceLevelTickerKey("NVDA", "NASDAQ")).toBe("NVDA:XNAS");
  expect(priceLevelTickerKey("NVDA", "NMS")).toBe("NVDA:XNAS");
  expect(priceLevelTickerKey("SAP", "XETRA")).toBe("SAP:XETR");
  for (const [symbol, exchange] of [["CL1", undefined], ["CL1", "NYMEX"], ["CL1", "NYM"], ["CL1F5R", undefined]] as const) {
    expect(priceLevelTickerKey(symbol, exchange)).toBe("CL1");
  }
  // A security that only spells like a generic keeps its listing.
  expect(priceLevelTickerKey("PL8", "ASX")).toBe("PL8:XASX");
});

test("past the listing cap the one just drawn on stays and the least recently edited goes", () => {
  let store = parsePriceLevels(Object.fromEntries(
    Array.from({ length: 400 }, (_, index) => [`T${index}`, [{ id: "a", price: index + 1 }]]),
  ));
  store = parsePriceLevels(editPriceLevels(store, "NEW", { kind: "add", id: "b", price: 5 }));
  expect(store.NEW).toHaveLength(1);
  expect(store.T0).toBeUndefined();
  expect(Object.keys(store)).toHaveLength(400);
});
