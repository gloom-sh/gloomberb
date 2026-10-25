import { afterEach, expect, spyOn, test } from "bun:test";
import { apiClient, type AuthUser } from "../api-client";
import { ChatController, chatController } from "../plugins/builtin/chat/controller";
import { MemoryPluginPersistence } from "../test-support/plugin-persistence";
import { performEmailAuth } from "./auth-model";
import { DeviceSignInController } from "./device-signin";
import { accountSession, registerAccountSession } from "./session";

const restore: Array<() => void> = [];
let sessionOwner: ChatController | undefined;
afterEach(() => {
  restore.splice(0).forEach((reset) => reset());
  sessionOwner?.reset(true);
  sessionOwner?.dispose();
  registerAccountSession(chatController);
  apiClient.dispose();
  apiClient.setSessionToken(null);
});

test.each(["email", "device"] as const)("%s sign-in persists through the registered session owner before an offline refresh", async (flow) => {
  expect(accountSession).toBe(chatController);
  apiClient.setSessionToken(null);
  apiClient.restoreCachedUser(null);
  const persistence = new MemoryPluginPersistence();
  sessionOwner = new ChatController();
  sessionOwner.attachPersistence(persistence);
  registerAccountSession(sessionOwner);
  const activity = spyOn(apiClient, "recordResearchActivity").mockResolvedValue(undefined);
  restore.push(() => activity.mockRestore());
  const user: AuthUser = {
    id: "account-session-test", email: "account@example.invalid", username: "account",
    name: "Account", emailVerified: true, plan: "free", image: null, createdAt: "", updatedAt: "",
  };
  let persistedBeforeRefresh: unknown;
  const refresh = spyOn(sessionOwner, "refreshSession").mockImplementation(async () => {
    persistedBeforeRefresh = persistence.getState("session", { schemaVersion: 1 });
    throw new Error("Offline after sign-in");
  });
  restore.push(() => refresh.mockRestore());

  if (flow === "email") {
    const signIn = spyOn(apiClient, "signIn").mockImplementation(async () => {
      apiClient.setSessionToken("account-test-token");
      apiClient.restoreCachedUser(user);
      return user;
    });
    restore.push(() => signIn.mockRestore());
    expect(await performEmailAuth("login", user.email, "test-password")).toBe(user);
  } else {
    const approved = Promise.withResolvers<AuthUser | null>();
    const controller = new DeviceSignInController({ io: {
      start: async () => ({
        deviceCode: "device-test", userCode: "TEST-CODE", verificationUri: "https://example.invalid/device",
        expiresAt: "1970-01-01T00:01:00.000Z", pollIntervalMs: 1000,
      }),
      poll: async () => ({ status: "approved", sessionToken: "account-test-token", user }),
      now: () => 0,
      delay: async () => {},
    } });
    const unsubscribe = controller.subscribe((snapshot) => {
      if (snapshot.phase === "approved") approved.resolve(snapshot.user);
    });
    try {
      controller.start();
      expect(await approved.promise).toBe(user);
    } finally {
      unsubscribe();
      controller.cancel();
    }
  }

  expect(refresh).toHaveBeenCalledTimes(1);
  expect(persistedBeforeRefresh).toMatchObject({
    sessionToken: "account-test-token", user: { id: user.id, emailVerified: true, plan: "free" },
  });
  expect(apiClient.getSessionToken()).toBe("account-test-token");
  expect(apiClient.getCurrentUser()?.id).toBe(user.id);
});
