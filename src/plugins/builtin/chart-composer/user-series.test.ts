import { describe, expect, test } from "bun:test";
import { validateSeriesDefinition } from "../../../series/validate";
import { userSeriesDefinitions } from "./user-series";

describe("series files", () => {
  test("one value column is one series named by the file; the unit and frequency fall back sensibly", async () => {
    let text = "date,value\n2024-01-01,1\n2024-02-01,2\n2024-03-01,3\n";
    const [series, ...rest] = userSeriesDefinitions("lemonade_sales.csv", text, async () => text);
    expect(rest).toEqual([]);
    expect(series).toMatchObject({
      id: "user:lemonade_sales",
      name: "Lemonade sales",
      unit: "number",
      frequency: "monthly",
      group: "Your series",
    });
    expect(() => validateSeriesDefinition(series!)).not.toThrow();
    // Each load reads the file again, so an edit shows on the next chart.
    text = "date,value\n2024-01-01,9\n";
    expect(await series!.load!({})).toEqual([{ date: new Date("2024-01-01T00:00:00Z"), value: 9 }]);
  });

  test("metadata lines name the series; several columns become several series under one name", () => {
    const text = [
      "# name: Stand",
      "# unit: thousand USD",
      "# frequency: weekly",
      "# group: Side projects",
      "date,Sales,Cups (count)",
      "2024-01-05,1,40",
      "2024-01-12,2,42",
    ].join("\n");
    const series = userSeriesDefinitions("Stand 2024.csv", text, async () => text);
    expect(series.map((entry) => [entry.id, entry.name, entry.unit, entry.frequency, entry.group])).toEqual([
      ["user:stand-2024.sales", "Stand: Sales", "thousand USD", "weekly", "Side projects"],
      ["user:stand-2024.cups-count", "Stand: Cups (count)", "thousand USD", "weekly", "Side projects"],
    ]);
    for (const entry of series) expect(() => validateSeriesDefinition(entry)).not.toThrow();
    // An unknown unit is not a reason to drop the file.
    expect(userSeriesDefinitions("x.csv", "# unit: furlongs\n2024-01-01,1", async () => "")[0]!.unit).toBe("number");
  });
});
