import { afterEach, expect, test } from "bun:test";
import { resetGeoCatalogCache, type GeoEntitiesPayload, type GeoRequest } from "../../../api-client/geo";
import { renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { createGeoFixtureRequest } from "../../../test-support/test-fixture-geo";
import type { HeadlessPaneContext } from "../../../types/headless";
import { trailingAverages } from "./chokepoint-report";
import { mapHeadless } from "./headless";

afterEach(() => resetGeoCatalogCache());

const daily = (from: string, values: readonly number[]) => values.map((value, index) => ({
  date: new Date(Date.parse(`${from}T00:00:00Z`) + index * 86_400_000).toISOString(), value,
}));

test("CHOKE's averages: the 7 and 28 days to the latest, against the same 28 days a year before, read on their own when the chart starts after them", () => {
  // 28 days to Sun 1 Nov 2026: three weeks at 4 a day, the last week at 2.
  const recent = daily("2026-10-05", [...Array(21).fill(4), ...Array(7).fill(2)]);
  // The chart's year starts on 11 Nov 2025, after the year-ago window (5 Oct to 1 Nov 2025): that is read apart.
  const yearAgo = daily("2025-10-05", Array(28).fill(62));
  expect(trailingAverages(recent, yearAgo)).toEqual({
    avg7: 2,
    avg28: 3.5,
    yearAgoAvg28: 62,
    changeVsYearAgoPct: (3.5 / 62 - 1) * 100,
  });
  // Without a year-ago window that reaches its first day, there is no change rather than one over a part of it.
  expect(trailingAverages(recent, yearAgo.slice(3))).toMatchObject({ avg28: 3.5, yearAgoAvg28: null, changeVsYearAgoPct: null });
  // A series that reaches back a year and more reads its own year-ago days.
  const long = [...daily("2025-10-05", Array(28).fill(10)), ...recent];
  expect(trailingAverages(long)).toMatchObject({ yearAgoAvg28: 10, changeVsYearAgoPct: -65 });
});

test("MAP ports: a percent column says %, a country's totals close the text table, and the title names the week the 7-day sums end on", async () => {
  const fixture = createGeoFixtureRequest();
  // The server reads "China" as the country, and totals every port it finds there.
  const request: GeoRequest = async <T,>(path: string, init?: RequestInit) => {
    const payload = await fixture<T>(path, init);
    if (!path.startsWith("layers/ports/entities")) return payload;
    return { ...(payload as GeoEntitiesPayload), matched: "country", totals: { calls7d: 1000, callsChgPct: 2.5, importT7d: 12_345_678 } } as T;
  };
  const apiClient = { geo: request } as unknown as HeadlessPaneContext["apiClient"];
  const args = createTestHeadlessArgs({ options: { layer: "ports", query: "China", limit: 3 } });
  const result = await mapHeadless.load(args, createTestHeadlessContext({ apiClient }));
  const change = result.columns!.find((column) => column.key === "callsChgPct")!;
  // Exports keep the bare number under a header that names the unit; the text writes it signed with its %.
  expect([change.header, change.textHeader, change.textFormat?.(2.5, {})]).toEqual(["Chg vs prior 7D (%)", "Chg vs prior 7D", "+2.5%"]);
  // The rows stay the ports; the text adds their country's total, over every port found and not only those listed.
  expect(result.rows.every((row) => row.id !== "total")).toBe(true);
  const total = result.textRows!.at(-1)!;
  expect(total).toMatchObject({ label: expect.stringMatching(/^Total, \d+ ports$/), country: "China", calls7d: 1000, callsChgPct: 2.5 });
  expect(result.metadata).toMatchObject({ matched: "country", weekEnding: "2026-10-02", totals: { calls7d: 1000 } });
  const text = renderHeadlessPaneText(mapHeadless, result, args, "World Map");
  expect(text.split("\n")[0]).toContain("World Map | ports | week ending Fri 2 Oct");
  expect(text).toContain("12,345,678");
});
