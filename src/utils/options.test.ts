import { expect, test } from "bun:test";

test("expiry labels preserve the contract date across investor time zones", () => {
  const modulePath = new URL("./options.ts", import.meta.url).pathname;
  // Separate processes exercise the host Date implementation without changing
  // the timezone used by other suites. Include DST and a year boundary.
  for (const timezone of ["America/New_York", "America/Los_Angeles", "Asia/Tokyo"]) {
    const result = Bun.spawnSync([process.execPath, "-e", `
      import { formatExpDate } from ${JSON.stringify(modulePath)};
      console.log(JSON.stringify([
        Date.UTC(2026, 8, 11), Date.UTC(2026, 9, 16),
        Date.UTC(2026, 10, 20), Date.UTC(2027, 0, 1),
      ].map(ms => formatExpDate(ms / 1000))));
    `], { env: { ...process.env, TZ: timezone }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual([
      "Sep 11 '26", "Oct 16 '26", "Nov 20 '26", "Jan 1 '27",
    ]);
  }
});
