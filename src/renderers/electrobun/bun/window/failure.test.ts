import { expect, spyOn, test } from "bun:test";
import { debugLog } from "../../../../utils/debug-log";
import { ElectrobunWindowHost } from "./electrobun-window-host";

test("displays that cannot be listed read as none and are logged without the error", () => {
  const now = spyOn(Date, "now").mockReturnValue(1_900_000_000_000);
  const logged: unknown[][] = [];
  const stop = debugLog.subscribe((entry) => {
    if (entry.source === "desktop-window") logged.push([entry.level, entry.message, entry.data]);
  });
  try {
    const shell = new ElectrobunWindowHost({
      create: () => { throw new Error("not opened here"); },
      readDisplays: () => { throw new Error("/Users/private/Library display=private"); },
    });
    expect(shell.listDisplays()).toEqual([]);
    // Once for the arrangement the host starts from; the second read falls in the same logging window.
    expect(logged).toEqual([["warn", expect.stringMatching(/^Could not list the displays(?: \(suppressed repeats: \d+\))?$/), undefined]]);
  } finally {
    stop();
    now.mockRestore();
  }
});
