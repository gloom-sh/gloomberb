import { describe, expect, test } from "bun:test";
import type { AuthUser, DeviceAuthStartResponse, DeviceAuthTokenResponse } from "../../../api-client";
import {
  DeviceSignInController,
  parseDeviceCodeExpiryMs,
  type DeviceSignInPhase,
  type DeviceSignInSnapshot,
} from "./device-signin";

const user = { id: "u1", email: "user@example.com", emailVerified: true } as AuthUser;

function startResponse(overrides: Partial<DeviceAuthStartResponse> = {}): DeviceAuthStartResponse {
  return {
    deviceCode: "device-1",
    userCode: "ABCD-EFGH",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    verificationUri: "https://gloom.sh/link/ABCD-EFGH",
    pollIntervalMs: 1_000,
    ...overrides,
  };
}

function waitForPhase(controller: DeviceSignInController, phase: DeviceSignInPhase): Promise<DeviceSignInSnapshot> {
  return new Promise((resolve, reject) => {
    if (controller.getSnapshot().phase === phase) {
      resolve(controller.getSnapshot());
      return;
    }
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for phase ${phase}`)), 1_000);
    const unsubscribe = controller.subscribe((snapshot) => {
      if (snapshot.phase !== phase) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(snapshot);
    });
  });
}

describe("DeviceSignInController", () => {
  test("polls through pending and adopts the session on approval", async () => {
    const polls: DeviceAuthTokenResponse[] = [
      { status: "pending" },
      { status: "pending" },
      { status: "approved", sessionToken: "token-1", user },
    ];
    const adopted: string[] = [];
    let pollCalls = 0;
    const controller = new DeviceSignInController({
      io: {
        start: async () => startResponse(),
        poll: async () => {
          pollCalls += 1;
          return polls.shift() ?? { status: "pending" };
        },
        adoptSession: async (sessionToken) => {
          adopted.push(sessionToken);
        },
        delay: async () => {},
      },
    });

    controller.start();
    const snapshot = await waitForPhase(controller, "approved");
    expect(snapshot.user).toEqual(user);
    expect(snapshot.userCode).toBe("ABCD-EFGH");
    expect(snapshot.verificationUri).toBe("https://gloom.sh/link/ABCD-EFGH");
    expect(adopted).toEqual(["token-1"]);
    expect(pollCalls).toBe(3);
  });

  test("stops on denial without adopting a session", async () => {
    let adoptCalls = 0;
    let pollCalls = 0;
    const controller = new DeviceSignInController({
      io: {
        start: async () => startResponse(),
        poll: async () => {
          pollCalls += 1;
          return { status: "denied" };
        },
        adoptSession: async () => {
          adoptCalls += 1;
        },
        delay: async () => {},
      },
    });

    controller.start();
    await waitForPhase(controller, "denied");
    expect(adoptCalls).toBe(0);
    expect(pollCalls).toBe(1);
  });

  test("restarts with a fresh code when the server reports expiry", async () => {
    let startCalls = 0;
    const controller = new DeviceSignInController({
      io: {
        start: async () => {
          startCalls += 1;
          return startResponse({ deviceCode: `device-${startCalls}`, userCode: `CODE-000${startCalls}` });
        },
        poll: async (deviceCode) =>
          deviceCode === "device-1"
            ? { status: "expired" }
            : { status: "approved", sessionToken: "token-2", user },
        adoptSession: async () => {},
        delay: async () => {},
      },
    });

    controller.start();
    const snapshot = await waitForPhase(controller, "approved");
    expect(startCalls).toBe(2);
    expect(snapshot.userCode).toBe("CODE-0002");
  });

  test("restarts at the local TTL even if the server never reports expiry", async () => {
    let nowMs = 0;
    let startCalls = 0;
    const controller = new DeviceSignInController({
      io: {
        start: async () => {
          startCalls += 1;
          return startResponse({
            deviceCode: `device-${startCalls}`,
            expiresAt: startCalls === 1 ? "not-a-date" : new Date(nowMs + 600_000).toISOString(),
          });
        },
        poll: async (deviceCode) =>
          deviceCode === "device-1"
            ? { status: "pending" }
            : { status: "approved", sessionToken: "token-3", user },
        adoptSession: async () => {},
        delay: async () => {
          nowMs += 400_000;
        },
        now: () => nowMs,
      },
    });

    controller.start();
    await waitForPhase(controller, "approved");
    expect(startCalls).toBe(2);
  });

  test("cancel stops polling", async () => {
    let pollCalls = 0;
    let release: (() => void) | null = null;
    const controller = new DeviceSignInController({
      io: {
        start: async () => startResponse(),
        poll: async () => {
          pollCalls += 1;
          return { status: "pending" };
        },
        adoptSession: async () => {},
        delay: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      },
    });

    controller.start();
    await waitForPhase(controller, "waiting");
    controller.cancel();
    release!();
    await Bun.sleep(0);
    expect(pollCalls).toBe(0);
    expect(controller.getSnapshot().phase).toBe("idle");
  });

  test("retries transport failures with backoff instead of crashing", async () => {
    const delays: number[] = [];
    let startAttempts = 0;
    let pollAttempts = 0;
    const controller = new DeviceSignInController({
      io: {
        start: async () => {
          startAttempts += 1;
          if (startAttempts === 1) throw new Error("offline");
          return startResponse();
        },
        poll: async () => {
          pollAttempts += 1;
          if (pollAttempts <= 2) throw new Error("bad gateway");
          return { status: "approved", sessionToken: "token-4", user };
        },
        adoptSession: async () => {},
        delay: async (ms) => {
          delays.push(ms);
        },
      },
    });

    controller.start();
    const errored = await waitForPhase(controller, "error");
    expect(errored.error).toBe("offline");
    const snapshot = await waitForPhase(controller, "approved");
    expect(snapshot.error).toBeNull();
    expect(startAttempts).toBe(2);
    // Start retry, then poll at the base interval with doubling on each failure.
    expect(delays).toEqual([2_000, 1_000, 2_000, 4_000]);
  });
});

describe("parseDeviceCodeExpiryMs", () => {
  test("falls back to a bounded TTL for unparseable values", () => {
    expect(parseDeviceCodeExpiryMs("not-a-date", 1_000)).toBe(601_000);
    expect(parseDeviceCodeExpiryMs(undefined, 0)).toBe(600_000);
  });

  test("accepts ISO timestamps and epoch milliseconds", () => {
    expect(parseDeviceCodeExpiryMs(new Date(5_000).toISOString(), 1_000)).toBe(5_000);
    expect(parseDeviceCodeExpiryMs(5_000, 1_000)).toBe(5_000);
  });
});
