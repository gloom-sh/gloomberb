import { expect, test } from "bun:test";
import { DEFAULT_LEVEL_COLOR, editPriceLevels, parsePriceLevels } from "./price-levels";

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
  const moved = editPriceLevels(added, "NVDA:XNAS", { kind: "move", id: "a", price: 231 });
  expect(moved["NVDA:XNAS"]![0]!.price).toBe(231);
  const emptied = editPriceLevels(
    editPriceLevels(moved, "NVDA:XNAS", { kind: "remove", id: "a" }),
    "NVDA:XNAS",
    { kind: "remove", id: "c" },
  );
  expect(emptied).toEqual({});
});
