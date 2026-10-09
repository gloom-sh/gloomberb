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
