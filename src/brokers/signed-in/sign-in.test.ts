import { describe, expect, test } from "bun:test";
import { ApiRequestError } from "../../api-client/errors";
import type { SignedInBroker } from "./client";
import {
  BrokerSignInController,
  runBrokerSignIn,
  type BrokerSignInIo,
  type BrokerSignInOutcome,
  type BrokerSignInSnapshot,
} from "./sign-in";

const IBKR: SignedInBroker = {
  id: "ibkr",
  name: "Interactive Brokers",
  capabilities: { history: true, executions: true, orders: false, singleConnection: true },
};

const ROBINHOOD: SignedInBroker = {
  id: "robinhood",
  name: "Robinhood",
  capabilities: { history: true, executions: true, orders: false, singleConnection: false },
};

const TRADING: SignedInBroker = {
  ...IBKR,
  capabilities: { ...IBKR.capabilities, orders: { mode: "review", types: ["MKT", "LMT"] } },
};

/** A virtual clock: `delay` advances time instead of waiting. */
function fakeIo(overrides: Partial<BrokerSignInIo>) {
  let now = 1_000_000;
  const io: BrokerSignInIo = {
    start: async () => ({ connectUrl: "https://gloom.sh/connect/t1", code: "K7QM", expiresAt: new Date(now + 60_000).toISOString() }),
    fetchConnection: async () => ({ status: "not_connected" }),
    now: () => now,
    delay: async (ms) => {
      now += ms;
      await Promise.resolve();
    },
    ...overrides,
  };
  return io;
}

function settle(controller: BrokerSignInController, done: (snapshot: BrokerSignInSnapshot) => boolean) {
  return new Promise<BrokerSignInSnapshot>((resolve) => {
    const unsubscribe = controller.subscribe((snapshot) => {
      if (!done(snapshot)) return;
      unsubscribe();
      resolve(snapshot);
    });
  });
}

describe("BrokerSignInController", () => {
  test("shows the link and code, then reports connected once the account is", async () => {
    let polls = 0;
    const controller = new BrokerSignInController(IBKR, false, fakeIo({
      fetchConnection: async () => ({ status: ++polls >= 3 ? "connected" : "not_connected" }),
    }));
    const waiting = settle(controller, (snapshot) => snapshot.phase === "waiting");
    const connected = settle(controller, (snapshot) => snapshot.phase === "connected");
    controller.start();
    expect(await waiting).toMatchObject({ connectUrl: "https://gloom.sh/connect/t1", code: "K7QM" });
    await connected;
    expect(polls).toBe(3);
  });

  test("asking for trading still finishes when the user grants only reading", async () => {
    const writes: boolean[] = [];
    let polls = 0;
    const controller = new BrokerSignInController(TRADING, true, fakeIo({
      start: async (_id, write) => {
        writes.push(write);
        return { connectUrl: "https://gloom.sh/connect/t1", code: "K7QM", expiresAt: new Date(2_000_000).toISOString() };
      },
      fetchConnection: async () => ({ status: ++polls >= 2 ? "connected" : "not_connected" }),
    }));
    const connected = settle(controller, (snapshot) => snapshot.phase === "connected");
    controller.start();
    await connected;
    expect(writes).toEqual([true]);
  });

  test("an expired code is replaced with a fresh one", async () => {
    let starts = 0;
    const controller = new BrokerSignInController(IBKR, true, fakeIo({
      start: async () => {
        starts += 1;
        return { connectUrl: `https://gloom.sh/connect/t${starts}`, code: `CODE${starts}`, expiresAt: new Date(1_000_000 + starts * 10_000).toISOString() };
      },
    }));
    const second = settle(controller, (snapshot) => snapshot.code === "CODE2");
    controller.start();
    expect((await second).connectUrl).toBe("https://gloom.sh/connect/t2");
    controller.cancel();
  });

  test("a device clock ahead of Gloom's keeps the code instead of asking for new ones", async () => {
    let starts = 0;
    let polls = 0;
    const io: BrokerSignInIo = fakeIo({
      start: async () => {
        starts += 1;
        // Gloom's expiry is already past by this device's clock.
        return { connectUrl: "https://gloom.sh/connect/t1", code: "K7QM", expiresAt: new Date(io.now() - 60_000).toISOString() };
      },
      fetchConnection: async () => ({ status: ++polls >= 5 ? "connected" : "not_connected" }),
    });
    const controller = new BrokerSignInController(IBKR, false, io);
    const settled = settle(controller, (snapshot) => snapshot.phase === "connected" || starts > 1);
    controller.start();
    const snapshot = await settled;
    controller.cancel();
    expect(starts).toBe(1);
    expect(snapshot.phase).toBe("connected");
    expect(polls).toBe(5);
  });

  test("a code that expires at once still waits a poll before the next one", async () => {
    const startedAt: number[] = [];
    const io: BrokerSignInIo = fakeIo({
      start: async () => {
        startedAt.push(io.now());
        return { connectUrl: "https://gloom.sh/connect/t1", code: `CODE${startedAt.length}`, expiresAt: new Date(io.now() + 1).toISOString() };
      },
    });
    const controller = new BrokerSignInController(IBKR, false, io);
    const third = settle(controller, (snapshot) => snapshot.code === "CODE3");
    controller.start();
    await third;
    controller.cancel();
    expect(startedAt[1]! - startedAt[0]!).toBeGreaterThanOrEqual(2_000);
    expect(startedAt[2]! - startedAt[1]!).toBeGreaterThanOrEqual(2_000);
  });

  test("a session Gloom refuses stops as signed out instead of retrying", async () => {
    let starts = 0;
    const controller = new BrokerSignInController(IBKR, true, fakeIo({
      start: async () => {
        starts += 1;
        throw new ApiRequestError("Unauthorized", 401);
      },
    }));
    const failed = settle(controller, (snapshot) => snapshot.phase === "signed-out");
    controller.start();
    expect((await failed).error).toBe("Sign in to Gloom first.");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(starts).toBe(1);
  });
});

describe("runBrokerSignIn", () => {
  function steps(options: { signedIn: boolean; outcomes: BrokerSignInOutcome[]; signInSucceeds?: boolean }) {
    const calls: string[] = [];
    const outcomes = [...options.outcomes];
    return {
      calls,
      steps: {
        isSignedIn: () => options.signedIn,
        signInToGloom: async () => {
          calls.push("gloom");
          return options.signInSucceeds ?? true;
        },
        connectBroker: async (broker: SignedInBroker, write: boolean) => {
          calls.push(`${broker.id}:${write ? "write" : "read"}`);
          return outcomes.shift() ?? "cancelled";
        },
      },
    };
  }

  test("asks for trading only where the broker takes orders, unless told otherwise", async () => {
    const readOnly = steps({ signedIn: true, outcomes: ["connected"] });
    expect(await runBrokerSignIn(ROBINHOOD, undefined, readOnly.steps)).toBe(true);
    expect(readOnly.calls).toEqual(["robinhood:read"]);

    const trading = steps({ signedIn: true, outcomes: ["connected"] });
    expect(await runBrokerSignIn(TRADING, undefined, trading.steps)).toBe(true);
    expect(trading.calls).toEqual(["ibkr:write"]);

    const forced = steps({ signedIn: true, outcomes: ["connected"] });
    await runBrokerSignIn(TRADING, false, forced.steps);
    expect(forced.calls).toEqual(["ibkr:read"]);
  });

  test("signs in to Gloom first when there is no session", async () => {
    const { calls, steps: run } = steps({ signedIn: false, outcomes: ["connected"] });
    expect(await runBrokerSignIn(IBKR, undefined, run)).toBe(true);
    expect(calls).toEqual(["gloom", "ibkr:read"]);

    const declined = steps({ signedIn: false, outcomes: ["connected"], signInSucceeds: false });
    expect(await runBrokerSignIn(IBKR, undefined, declined.steps)).toBe(false);
    expect(declined.calls).toEqual(["gloom"]);
  });

  test("a session Gloom refused signs in again and retries the broker once", async () => {
    const retried = steps({ signedIn: true, outcomes: ["signed-out", "connected"] });
    expect(await runBrokerSignIn(IBKR, undefined, retried.steps)).toBe(true);
    expect(retried.calls).toEqual(["ibkr:read", "gloom", "ibkr:read"]);

    const twice = steps({ signedIn: true, outcomes: ["signed-out", "signed-out", "connected"] });
    expect(await runBrokerSignIn(IBKR, undefined, twice.steps)).toBe(false);
    expect(twice.calls).toEqual(["ibkr:read", "gloom", "ibkr:read"]);

    const cancelled = steps({ signedIn: true, outcomes: ["signed-out"], signInSucceeds: false });
    expect(await runBrokerSignIn(IBKR, undefined, cancelled.steps)).toBe(false);
    expect(cancelled.calls).toEqual(["ibkr:read", "gloom"]);
  });
});
