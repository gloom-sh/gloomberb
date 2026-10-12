import { expect, test } from "bun:test";
import { formatOptionTicker, optionContractName } from "./options";

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

test("an option contract reads the same from an OCC code as from a broker's spaced symbol", () => {
  for (const symbol of ["AAPL261218C00300000", "AAPL  261218C00300000", "AAPL 261218C00300000"]) {
    expect(formatOptionTicker(symbol)).toBe("AAPL C $300 Dec'26");
    expect(optionContractName(symbol)).toBe("AAPL Dec 18 '26 $300 Call");
  }
  // Strikes are in thousandths, and a root can end in a digit or hold a dot.
  expect(optionContractName("BRK.B270115P00012750")).toBe("BRK.B Jan 15 '27 $12.75 Put");
  expect(formatOptionTicker("F260821C00012500")).toBe("F C $12.5 Aug'26");
  // Anything else is left as it was, including a date no calendar has.
  for (const symbol of ["AAPL", "BZ-USD", "AAPL261318C00300000", "AAPL260231C00300000"]) {
    expect(formatOptionTicker(symbol)).toBe(symbol);
    expect(optionContractName(symbol)).toBeNull();
  }
});
