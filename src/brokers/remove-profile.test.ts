import { afterEach, expect, test } from "bun:test";
import { apiClient } from "../api-client";
import { ApiRequestError } from "../api-client/errors";
import type { BrokerInstanceConfig } from "../types/config";
import { removeBrokerProfile } from "./remove-profile";

const signedIn: BrokerInstanceConfig = { id: "ibkr-main", brokerType: "signed-in", label: "IBKR", connectionMode: "ibkr", config: {} };
const brokerRequest = apiClient.brokerRequest;

afterEach(() => {
  apiClient.brokerRequest = brokerRequest;
});

// Removing used to stop at the account-wide disconnect: any answer but 401 or
// 404 (a 5xx, no network) threw before the profile went, so it never could.
test("a signed-in profile goes whatever Gloom answers its disconnect, and says what the account kept", async () => {
  const kept = "Removed IBKR. Interactive Brokers is still connected to your Gloom account.";
  const answers: Array<[string, () => Promise<unknown>, { message: string; accountKept: boolean }]> = [
    ["disconnected", async () => ({ disconnected: true }), { message: "Removed IBKR.", accountKept: false }],
    ["already gone", async () => { throw new ApiRequestError("Not found", 404); }, { message: "Removed IBKR.", accountKept: false }],
    ["server error", async () => { throw new ApiRequestError("Internal error", 500); }, { message: kept, accountKept: true }],
    ["offline", async () => { throw new TypeError("fetch failed"); }, { message: kept, accountKept: true }],
    ["signed out", async () => { throw new ApiRequestError("Unauthorized", 401); }, {
      message: `${kept} Sign in to Gloom to disconnect Interactive Brokers from your account.`,
      accountKept: true,
    }],
  ];

  for (const [answer, request, expected] of answers) {
    apiClient.brokerRequest = request as typeof apiClient.brokerRequest;
    const removed: string[] = [];
    const removal = await removeBrokerProfile(signedIn, "Interactive Brokers", async (id) => { removed.push(id); });
    expect({ answer, removed, ...removal }).toEqual({ answer, removed: ["ibkr-main"], ...expected });
  }
});
