import { describe, expect, test } from "bun:test";
import { ApiRequestError } from "../../api-client/errors";
import type { SignedInBroker } from "./client";
import { BrokerSignInController, type BrokerSignInIo, type BrokerSignInSnapshot } from "./sign-in";

const IBKR: SignedInBroker = {
  id: "ibkr",
  name: "Interactive Brokers",
  capabilities: { history: true, executions: true, orders: false, singleConnection: true },
};

/** A virtual clock: `delay` advances time instead of waiting. */
function fakeIo(overrides: Partial<BrokerSignInIo>) {
  let now = 1_000_000;
  const io: BrokerSignInIo = {
    start: async () => ({ connectUrl: "https://gloom.sh/connect/t1", code: "K7QM", expiresAt: new Date(now + 60_000).toISOString() }),
    isConnected: async () => false,
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
  test("shows the link and code, then reports connected once trading is granted", async () => {
    let polls = 0;
    const controller = new BrokerSignInController(IBKR, true, fakeIo({
      isConnected: async (_id, write) => write && ++polls >= 3,
    }));
    const waiting = settle(controller, (snapshot) => snapshot.phase === "waiting");
    const connected = settle(controller, (snapshot) => snapshot.phase === "connected");
    controller.start();
    expect(await waiting).toMatchObject({ connectUrl: "https://gloom.sh/connect/t1", code: "K7QM" });
    await connected;
    expect(polls).toBe(3);
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

  test("signed out of Gloom stops with a clear message instead of retrying", async () => {
    let starts = 0;
    const controller = new BrokerSignInController(IBKR, true, fakeIo({
      start: async () => {
        starts += 1;
        throw new ApiRequestError("Unauthorized", 401);
      },
    }));
    const failed = settle(controller, (snapshot) => snapshot.phase === "error");
    controller.start();
    expect((await failed).error).toBe("Sign in to Gloom first.");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(starts).toBe(1);
  });
});
