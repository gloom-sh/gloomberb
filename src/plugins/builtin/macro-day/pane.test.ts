import { expect, test } from "bun:test";
import type { MacroDayEvent } from "./model";
import { columnsFor, moveTone } from "./pane";

const day = (figures: MacroDayEvent["figures"]): MacroDayEvent => ({ kind: "jobs", date: "2026-10-02", session: "2026-10-02", move: 0.01,
  multiple: 1, earnings: false, figures });

test("figure columns carry the economic calendar's labels, each as wide as its header and its widest value", () => {
  const rows = [
    day({ event: "Non Farm Payrolls", actual: "29K", forecast: "-1,250.5K", prior: "133K", surprise: "cool" }),
    day(null),
  ];
  const figures = columnsFor("all", rows).filter((column) => ["actual", "forecast", "prior"].includes(column.id));
  expect(figures.map((column) => column.label)).toEqual(["Actual", "Forecast", "Prior"]);
  // A header keeps two cells for its sort marker; a value fits whole.
  expect(figures.map((column) => column.width)).toEqual([8, 10, 7]);
  // Days without figures show none of the three columns.
  expect(columnsFor("all", [day(null)]).map((column) => column.id)).toEqual(["date", "release", "move", "multiple"]);
  // A yield's moves are basis points, and the column says so.
  expect(columnsFor("all", [day(null)], "yield").find((column) => column.id === "move")!.label).toBe("Move bp");
});

test("an average move that rounds to 0.00% is neither up nor down", () => {
  expect(moveTone(0.00004)).toBeUndefined();
  expect(moveTone(-0.00004)).toBeUndefined();
  expect(moveTone(null)).toBeUndefined();
  expect(moveTone(0.0001)).toBe("positive");
  expect(moveTone(-0.0001)).toBe("negative");
});
