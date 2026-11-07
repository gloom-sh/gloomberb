import { expect, jest, spyOn, test } from "bun:test";
import { setCliColorEnabledOverride } from "../../../../utils/cli-output";
import { progressNotice } from "./bulk-symbols";

test("a slow add says it is looking its symbols up before any answers, then how far it got, and stops once all are", () => {
  setCliColorEnabledOverride(false);
  jest.useFakeTimers();
  const lines: string[] = [];
  const error = spyOn(console, "error").mockImplementation((line: unknown) => { lines.push(String(line)); });
  try {
    // A 10-name add sat silent for 7.9 s while its first answer was out.
    const tell = progressNotice({ cliOptions: { quiet: false } } as never);
    tell(0, 10);
    jest.advanceTimersByTime(1_999);
    expect(lines).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(lines).toEqual(["Looking up 10 symbols."]);
    jest.advanceTimersByTime(5_000);
    tell(4, 10);
    jest.advanceTimersByTime(5_000);
    expect(lines).toEqual(["Looking up 10 symbols.", "Looked up 0 of 10 symbols.", "Looked up 4 of 10 symbols."]);
    tell(10, 10);
    jest.advanceTimersByTime(20_000);
    expect(lines).toHaveLength(3);
    // One symbol, a quick lookup, or --quiet: nothing.
    const quick = progressNotice({ cliOptions: { quiet: false } } as never);
    quick(0, 3);
    jest.advanceTimersByTime(1_500);
    quick(3, 3);
    progressNotice({ cliOptions: { quiet: false } } as never)(0, 1);
    progressNotice({ cliOptions: { quiet: true } } as never)(0, 10);
    jest.advanceTimersByTime(20_000);
    expect(lines).toHaveLength(3);
  } finally {
    error.mockRestore();
    jest.useRealTimers();
    setCliColorEnabledOverride(null);
  }
});
