import { expect, test } from "bun:test";

for (const zone of ["Asia/Tokyo", "America/Los_Angeles"]) {
  test(`midnight instants retain their time and zone under ${zone}`, async () => {
    const child = Bun.spawn([process.execPath, "--eval", `
      import { formatUtcTime, parseReportTime } from "./src/utils/utc-time";
      import { serializeCliResult } from "./src/cli/result";
      import { DEFAULT_CLI_OPTIONS } from "./src/cli/options";
      const values = [new Date("2026-10-09T00:00:00Z"), "2026-10-09T00:00:00Z",
        "2026-10-09T09:00:00+09:00", Date.parse("2026-10-09T00:00:00Z"), "2026-10-09"];
      console.log(JSON.stringify(values.map(value => formatUtcTime(value))));
      console.log(formatUtcTime({ ...parseReportTime(values[0]), dateOnly: true }));
      for (const value of values) {
        console.log(serializeCliResult({ data: { updatedAt: value } }, { ...DEFAULT_CLI_OPTIONS, color: false }));
      }
      console.log(serializeCliResult({ data: { timestamp: values[3] } }, { ...DEFAULT_CLI_OPTIONS, color: false }));
    `], { cwd: process.cwd(), env: { ...process.env, TZ: zone, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ stderr, status }).toEqual({ stderr: "", status: 0 });
    const [formatted, explicitDaily, ...cells] = stdout.trim().split("\n");
    expect(JSON.parse(formatted!)).toEqual([
      "2026-10-09 00:00 UTC", "2026-10-09 00:00 UTC", "2026-10-09 00:00 UTC", "2026-10-09 00:00 UTC", "2026-10-09",
    ]);
    expect(explicitDaily).toBe("2026-10-09");
    expect(cells).toEqual([
      ...Array.from({ length: 4 }, () => "Updated At  2026-10-09 00:00 UTC"),
      "Updated At  2026-10-09",
      "Timestamp  2026-10-09 00:00 UTC",
    ]);
  });
}

test("a viewer's clock names its zone's day and time, with the weekday when it is another day than UTC's", async () => {
  const { readerTimeZone, timeZoneCity, zonedClock } = await import("./utc-time");
  expect(zonedClock(Date.parse("2026-10-23T12:00:00Z"), "America/New_York")).toEqual({ date: "2026-10-23", time: "08:00", label: "08:00" });
  expect(zonedClock(Date.parse("2026-10-14T01:30:00Z"), "America/New_York")).toEqual({ date: "2026-10-13", time: "21:30", label: "Tue 21:30" });
  expect(zonedClock(Date.parse("2026-10-23T22:00:00Z"), "Asia/Tokyo").label).toBe("Sat 07:00");
  expect(timeZoneCity("America/Sao_Paulo")).toBe("Sao Paulo");
  expect([readerTimeZone("america/new_york"), readerTimeZone("Etc/UTC"), readerTimeZone("EST5"), readerTimeZone(undefined)])
    .toEqual(["America/New_York", null, null, null]);
});
