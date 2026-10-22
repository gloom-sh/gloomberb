import { describe, expect, test } from "bun:test";
import type { CloudThesis } from "../../../../api-client";
import type { PluginPersistence } from "../../../../types/plugin";
import { ThesisStore } from "./store";

const thesis = (id: string) => ({ id, title: id }) as unknown as CloudThesis;

/** A client whose list requests stay open until the test settles them. */
function setup(cached: CloudThesis[] = []) {
  let verified = true;
  const userListeners = new Set<() => void>();
  const requests: Array<{ resolve: (theses: CloudThesis[]) => void; reject: (error: Error) => void }> = [];
  const client = {
    isVerified: () => verified,
    getCurrentUser: () => null,
    subscribeCurrentUser: (listener: () => void) => {
      userListeners.add(listener);
      return () => { userListeners.delete(listener); };
    },
    subscribeCloudEvent: () => () => {},
    listTheses: () => new Promise<CloudThesis[]>((resolve, reject) => { requests.push({ resolve, reject }); }),
  };
  const saved = new Map<string, unknown>();
  if (cached.length > 0) saved.set("thesis-cache", cached);
  const persistence = {
    getState: (key: string) => saved.get(key) ?? null,
    setState: (key: string, value: unknown) => { saved.set(key, value); },
  } as unknown as PluginPersistence;
  const store = new ThesisStore(client as unknown as ConstructorParameters<typeof ThesisStore>[0]);
  store.attach(persistence);
  return {
    store,
    requests,
    saved,
    signOut: () => {
      verified = false;
      for (const listener of userListeners) listener();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ThesisStore refresh", () => {
  test("a request from before a restart cannot fail the refresh that replaced it", async () => {
    const { store, requests } = setup([thesis("cached")]);
    store.start();
    store.dispose();
    store.start();
    expect(requests).toHaveLength(2);

    requests[0]!.reject(new Error("Unauthorized"));
    await settle();
    expect(store.getSnapshot()).toMatchObject({ loading: true, error: null, offline: false });

    requests[1]!.resolve([thesis("fresh")]);
    await settle();
    expect(store.getSnapshot()).toMatchObject({ loading: false, loaded: true, error: null, offline: false });
    expect(store.getSnapshot().theses.map((entry) => entry.id)).toEqual(["fresh"]);
  });

  test("an answer that lands after dispose writes neither the list nor the on-device copy", async () => {
    const { store, requests, saved } = setup();
    store.start();
    store.dispose();
    expect(store.getSnapshot().loading).toBe(false);

    requests[0]!.resolve([thesis("late")]);
    await settle();
    expect(store.getSnapshot().theses).toEqual([]);
    expect(saved.has("thesis-cache")).toBe(false);
  });

  test("an answer that lands after sign-out does not bring the account's theses back", async () => {
    const { store, requests, saved, signOut } = setup();
    store.start();
    signOut();
    expect(store.getSnapshot().loading).toBe(false);

    requests[0]!.resolve([thesis("theirs")]);
    await settle();
    expect(store.getSnapshot().theses).toEqual([]);
    expect(saved.has("thesis-cache")).toBe(false);
  });
});
