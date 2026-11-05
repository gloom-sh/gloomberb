import { expect, mock, spyOn, test } from "bun:test";
import { debugLog } from "../../../../utils/debug-log";

// The real module reaches the webview's `window` on load; the view's persistence only needs its request call.
const requests: string[] = [];
mock.module("../backend-rpc", () => ({
  getElectrobunBackendInitSnapshot: () => null,
  backendRequest: async (method: string) => {
    requests.push(method);
    throw new Error("token=private portfolio=private");
  },
}));

test("a failed immediate plugin state save is logged without the error, and the value stays readable", async () => {
  const now = spyOn(Date, "now").mockReturnValue(1_900_000_000_000);
  const logged: unknown[][] = [];
  const stop = debugLog.subscribe((entry) => {
    if (entry.source === "desktop-view-persistence") logged.push([entry.level, entry.message, entry.data]);
  });
  try {
    const { RemotePersistence } = await import("./persistence");
    const persistence = new RemotePersistence();
    persistence.pluginState.set("gloomberb-cloud", "session", { token: "private" });
    await Bun.sleep(0);
    expect(requests).toEqual(["pluginState.setMany"]);
    expect(persistence.pluginState.get("gloomberb-cloud", "session")?.value).toEqual({ token: "private" });
    expect(logged).toEqual([["warn", expect.stringMatching(/^Could not save plugin state right away(?: \(suppressed repeats: \d+\))?$/), undefined]]);
  } finally {
    stop();
    now.mockRestore();
  }
});
