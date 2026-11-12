import { describe, expect, test } from "bun:test";
import { renameIntoPlace } from "./replace-file";

function refusing(times: number, code: string) {
  const calls: string[] = [];
  return {
    calls,
    rename: async (source: string, target: string) => {
      calls.push(`${source}->${target}`);
      if (calls.length <= times) throw Object.assign(new Error(`${code}: rename`), { code });
    },
  };
}

describe("renameIntoPlace", () => {
  test("on Windows a file held open for a moment still lands, and a held file that never frees fails", async () => {
    const slept: number[] = [];
    const sleep = async (ms: number) => { slept.push(ms); };

    const brief = refusing(2, "EPERM");
    await renameIntoPlace("config.json.tmp", "config.json", { platform: "win32", rename: brief.rename, sleep });
    expect(brief.calls).toHaveLength(3);

    const held = refusing(Number.POSITIVE_INFINITY, "EBUSY");
    await expect(renameIntoPlace("a", "b", { platform: "win32", rename: held.rename, sleep })).rejects.toThrow("EBUSY");
    // Bounded: it gives up rather than hang the save the user waits on.
    expect(held.calls.length).toBeLessThan(10);
  });

  test("elsewhere, and for any other failure, the first refusal is the answer", async () => {
    const sleep = async () => { throw new Error("should not wait"); };
    const posix = refusing(1, "EACCES");
    await expect(renameIntoPlace("a", "b", { platform: "linux", rename: posix.rename, sleep })).rejects.toThrow("EACCES");
    expect(posix.calls).toHaveLength(1);

    const missing = refusing(1, "ENOENT");
    await expect(renameIntoPlace("a", "b", { platform: "win32", rename: missing.rename, sleep })).rejects.toThrow("ENOENT");
    expect(missing.calls).toHaveLength(1);
  });
});
