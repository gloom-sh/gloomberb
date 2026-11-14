import { expect, test } from "bun:test";
import type { MacroDayEvent } from "./model";
import { columnsFor, macroSurpriseText, moveTone } from "./pane";

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
  // A policy decision widens the release's name; with one release picked, it is the row's note.
  const fomc = { ...day({ event: "Federal funds target range", actual: "3.75-4.00%", forecast: null, prior: "3.50-3.75%", surprise: null,
    decision: "raised 25bp" }), kind: "fomc" as const };
  expect(columnsFor("all", [fomc]).find((column) => column.id === "release")!.width).toBe("FOMC raised 25bp".length);
  expect(columnsFor("fomc", [fomc]).find((column) => column.id === "release")!.label).toBe("Note");
  expect(columnsFor("jobs", [day(null)]).map((column) => column.id)).toEqual(["date", "move", "multiple"]);
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

test("the Surprise column says hot, cool or in line in words, and names the print a surprise was read from", () => {
  // The pane showed a surprise only as the Actual's colour; the CLI had words.
  const hot = day({ event: "Inflation Rate YoY", actual: "3.7%", forecast: "3.6%", prior: "3.4%", surprise: "hot" });
  const read = day({ event: "Inflation Rate YoY", actual: null, forecast: "3.9%", prior: "3.7%", surprise: null,
    surpriseBasis: { basis: "core m/m", actual: "0.3%", forecast: "0.2%", surprise: "hot" } });
  const cool = day({ event: "Non Farm Payrolls", actual: "29K", forecast: "50K", prior: "133K", surprise: "cool" });
  const level = day({ event: "Non Farm Payrolls", actual: "50K", forecast: "50K", prior: "133K", surprise: "in-line" });
  expect([hot, read, cool, level, day(null)].map(macroSurpriseText)).toEqual(["Hot", "Hot (core m/m)", "Cool", "In line", ""]);
  const surprise = columnsFor("cpi", [hot, read]).find((column) => column.id === "surprise")!;
  expect(surprise.label).toBe("Surprise");
  expect(surprise.width).toBe("Hot (core m/m)".length);
});
