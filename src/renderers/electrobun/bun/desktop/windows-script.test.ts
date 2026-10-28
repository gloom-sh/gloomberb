import { describe, expect, test } from "bun:test";
import { psString, scriptAnswer } from "./windows-script";

describe("the scripts the Windows app leaves", () => {
  // PowerShell ends a single-quoted string at any of ' ‘ ’ ‚ ‛ unless it is doubled.
  test("quote a path with any quote PowerShell reads in it", () => {
    expect(psString("C:\\Users\\O'Brien")).toBe("'C:\\Users\\O''Brien'");
    expect(psString("C:\\Users\\O\u2019Brien\\\u2018a\u201Ab\u201B")).toBe("'C:\\Users\\O\u2019\u2019Brien\\\u2018\u2018a\u201A\u201Ab\u201B\u201B'");
    expect(psString("C:\\Users\\\u201CJo\u201D")).toBe("'C:\\Users\\\u201CJo\u201D'");
  });

  test("read the script's first answer from its log", () => {
    expect(scriptAnswer("")).toBeNull();
    expect(scriptAnswer("2026-10-28T18:11:44.5+00:00 started 4120\r\n2026-10-28T18:11:50+00:00 move failed: x\r\n")).toEqual({ kind: "started" });
    expect(scriptAnswer("2026-10-28T18:11:44+00:00 busy: C:\\Tools\\bin\\bun.exe runs\r\n")).toEqual({ kind: "busy", reason: "C:\\Tools\\bin\\bun.exe runs" });
    expect(scriptAnswer("2026-10-28T18:11:44+00:00 declined: cannot write in C:\\Tools\r\n")).toEqual({ kind: "declined", reason: "cannot write in C:\\Tools" });
    expect(scriptAnswer("2026-10-28T18:11:44+00:00 the app stopped waiting before this started\r\n")).toBeNull();
  });
});
