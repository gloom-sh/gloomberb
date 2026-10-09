import { expect, test } from "bun:test";
import type { GeoColumn } from "../../../api-client/geo";
import { getTableWidth } from "../../../components/ui/table-layout";
import { entityColumns, TICKER_COLUMN_ID } from "./entity-table";

const ships: GeoColumn[] = [
  { key: "label", label: "Ship" },
  { key: "class", label: "Class" },
  { key: "mmsi", label: "MMSI", align: "right", format: "text" },
  { key: "speedKn", label: "Speed", align: "right", format: "knots" },
  { key: "destination", label: "Destination" },
  { key: "lastSeen", label: "Last seen", align: "right", format: "datetime" },
];

test("the table keeps the name and the ticker, fills in the layer's order, and drops codes first", () => {
  const ids = (width: number) => entityColumns(ships, width).map((column) => column.id);
  expect(ids(24)).toEqual(["label"]);
  expect(ids(30)).toEqual(["label", TICKER_COLUMN_ID]);
  expect(ids(46)).toEqual(["label", "class", "speedKn", TICKER_COLUMN_ID]);
  expect(ids(200)).toEqual(["label", "class", "mmsi", "speedKn", "destination", "lastSeen", TICKER_COLUMN_ID]);
  for (const width of [24, 46, 70, 200]) {
    expect(getTableWidth(entityColumns(ships, width))).toBeLessThanOrEqual(width);
  }
});
