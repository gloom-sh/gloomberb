import { describe, expect, test } from "bun:test";
import { setAppBadge } from "./app-badge";

function setters() {
  const calls: string[] = [];
  return { calls, darwin: (label: string) => calls.push(label) };
}

describe("setAppBadge", () => {
  test("hands a count to the platform that has a badge", () => {
    const { calls, darwin } = setters();
    setAppBadge("7", "darwin", { darwin });
    setAppBadge("99+", "darwin", { darwin });
    setAppBadge("", "darwin", { darwin });
    expect(calls).toEqual(["7", "99+", ""]);
  });

  test("does nothing where the platform has no badge", () => {
    const { calls, darwin } = setters();
    setAppBadge("7", "win32", { darwin });
    setAppBadge("7", "linux", { darwin });
    expect(calls).toEqual([]);
  });

  test("never passes anything but a count on, so message text cannot reach the Dock", () => {
    const { calls, darwin } = setters();
    for (const label of ["bob: see you at 5", "0", "007", "100", "1e3", "-2", "99+ new", " 5"]) {
      setAppBadge(label, "darwin", { darwin });
    }
    setAppBadge(undefined as unknown as string, "darwin", { darwin });
    expect(calls).toEqual(["", "", "", "", "", "", "", "", ""]);
  });
});
