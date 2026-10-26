import { describe, expect, test } from "bun:test";
import { getTableWidth } from "../../../components/ui/table-layout";
import { columnsForTab } from "./table-model";
import type { BuildoutList } from "./model/types";

const list = { id: "1", slug: "dram", name: "DRAM Memory" } as BuildoutList;
const idsOf = (selected: BuildoutList | null, width: number) =>
  columnsForTab("companies", selected, true, width).map((column) => column.id);

describe("the Companies tab's columns", () => {
  test("a narrow pane gives up the description first, so no figure runs past the right edge", () => {
    // The table keeps one cell for its scrollbar.
    for (const selected of [null, list]) {
      for (const width of [80, 90, 100, 120, 160, 200]) {
        expect(getTableWidth(columnsForTab("companies", selected, true, width))).toBeLessThanOrEqual(width - 1);
      }
    }
    expect(idsOf(null, 90)).toEqual(["listName", "companyCount", "totalMarketCap", "avgSectorGrowth", "avgReturn1y"]);
    expect(idsOf(list, 90)).not.toContain("description");
    expect(idsOf(list, 90)).toContain("marketCap");
  });

  test("a pane wide enough keeps every column of the lists", () => {
    expect(idsOf(null, 140)).toContain("listDescription");
    expect(idsOf(null, 140)).toContain("avgMargin");
  });
});
