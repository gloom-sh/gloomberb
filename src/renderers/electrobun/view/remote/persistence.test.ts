import { beforeEach, expect, mock, test } from "bun:test";

// The real module reaches the webview's `window` on load. This stands in for the Bun process: what it has saved,
// whether its requests fail, and a gate that holds them in flight.
const saved = { pluginState: new Map<string, unknown>(), sessions: new Map<string, unknown>() };
let failing = false;
let gate: Promise<void> | null = null;

mock.module("../backend-rpc", () => ({
  getElectrobunBackendInitSnapshot: () => {
    const pluginState: Record<string, Record<string, unknown>> = {};
    for (const [id, value] of saved.pluginState) {
      const [pluginId, key] = id.split("/") as [string, string];
      (pluginState[pluginId] ??= {})[key] = value;
    }
    return { pluginState };
  },
  backendRequest: async (method: string, payload: Record<string, unknown>) => {
    const fails = failing;
    if (gate) await gate;
    if (fails) throw new Error("token=private");
    if (method === "pluginState.setMany") {
      for (const entry of payload.entries as Array<{ pluginId: string; key: string; value: unknown }>) {
        saved.pluginState.set(`${entry.pluginId}/${entry.key}`, entry.value);
      }
    } else if (method === "pluginState.delete") {
      saved.pluginState.delete(`${payload.pluginId}/${payload.key}`);
    } else if (method === "session.set") {
      saved.sessions.set(payload.sessionId as string, payload.value);
    } else if (method === "session.delete") {
      saved.sessions.delete(payload.sessionId as string);
    }
    return null;
  },
}));

const { RemotePersistence } = await import("./persistence");

/** Lets an immediate save, which nothing awaits, settle. */
const settle = () => Bun.sleep(5);

beforeEach(() => {
  saved.pluginState.clear();
  saved.sessions.clear();
  failing = false;
  gate = null;
});

test("a failed sign-in save goes out with the next save, so the next launch is still signed in", async () => {
  const view = new RemotePersistence();
  failing = true;
  view.pluginState.set("gloomberb-cloud", "session", { token: "fixture" });
  await settle();
  expect(saved.pluginState.has("gloomberb-cloud/session")).toBe(false);

  failing = false;
  view.pluginState.set("watchlist", "columns", ["last"]);
  await view.pluginState.flush();

  const relaunched = new RemotePersistence();
  expect(relaunched.pluginState.get("gloomberb-cloud", "session")?.value).toEqual({ token: "fixture" });
  expect(relaunched.pluginState.get("watchlist", "columns")?.value).toEqual(["last"]);
});

test("a failed debounced save and a failed deletion go out with the next flush", async () => {
  saved.pluginState.set("notes/draft", "old");
  const view = new RemotePersistence();
  failing = true;
  view.pluginState.set("watchlist", "columns", ["last"]);
  await view.pluginState.flush();
  view.pluginState.delete("notes", "draft");
  await settle();
  expect(Object.fromEntries(saved.pluginState)).toEqual({ "notes/draft": "old" });

  failing = false;
  await view.pluginState.flush();
  expect(Object.fromEntries(saved.pluginState)).toEqual({ "watchlist/columns": ["last"] });
});

test("a change made while a save fails replaces the failed one instead of being overwritten by it", async () => {
  saved.pluginState.set("notes/pinned", "old");
  const view = new RemotePersistence();
  let release!: () => void;
  gate = new Promise((resolve) => { release = resolve; });
  failing = true;
  view.pluginState.delete("notes", "pinned");
  await settle();
  // The deletion is in flight and will fail; this newer value arrives meanwhile.
  failing = false;
  view.pluginState.set("notes", "pinned", "new");
  release();
  await settle();
  gate = null;

  await view.pluginState.flush();
  expect(Object.fromEntries(saved.pluginState)).toEqual({ "notes/pinned": "new" });
});

test("deleting one saved session leaves another session's pending save alone", async () => {
  const view = new RemotePersistence();
  view.sessions.set("app", { layout: "fixture" });
  view.sessions.delete("detached");
  await view.sessions.flush();
  expect(saved.sessions.get("app")).toEqual({ layout: "fixture" });
});
