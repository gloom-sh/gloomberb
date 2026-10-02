import { describe, expect, spyOn, test } from "bun:test";
import { apiClient, type AuthUser } from "../../api-client";
import { ApiRequestError } from "../../api-client/errors";
import type { SignedInBroker } from "../../brokers/signed-in/client";
import { SIGNED_IN_BROKER_TYPE } from "../../brokers/signed-in/profile";
import { chatController } from "../../plugins/builtin/chat/controller";
import type { PluginRegistry } from "../../plugins/registry";
import type { AppContextStoreValue } from "../../state/app/context";
import type { BrokerInstanceConfig } from "../../types/config";
import { buildBrokerWorkflowRoute } from "../command-bar/workflow/broker";
import { openFormModal } from "./request";
import { CTRL_S, ENTER, ESC, createFormModalTestSession } from "./test-harness";

const session = createFormModalTestSession();
const { frame, press, renderForm, settle, spy, waitForForm, waitForFrameToContain } = session;

describe("broker connect step", () => {
  const ROBINHOOD: SignedInBroker = {
    id: "robinhood",
    name: "Robinhood",
    capabilities: { history: true, executions: true, orders: false, singleConnection: true },
  };
  const DIRECTORY = [{ key: "robinhood", name: "Robinhood", methods: [{ kind: "signed-in" as const, broker: ROBINHOOD }] }];
  const PROFILE: BrokerInstanceConfig = {
    id: "rh-1",
    brokerType: SIGNED_IN_BROKER_TYPE,
    label: "Robinhood",
    connectionMode: "robinhood",
    config: { broker: "robinhood" },
  };

  /** New Portfolio, on Robinhood unless the test picks the source itself. */
  function brokerRoute(source: "robinhood" | "manual" = "robinhood") {
    const route = buildBrokerWorkflowRoute({
      directory: DIRECTORY,
      submitLabel: "Create Portfolio",
      subtitle: undefined,
      title: "New Portfolio",
    });
    return { ...route, values: { ...route.values, source } };
  }

  /**
   * Gloom Cloud for the connect: `connect` answers each code request, and the
   * connection reads connected from the first poll, two seconds in.
   */
  function fakeCloud({ signedIn, connect }: { signedIn: () => boolean; connect: () => unknown }) {
    spy(spyOn(apiClient, "isSignedIn").mockImplementation(signedIn));
    spy(spyOn(apiClient, "brokerRequest").mockImplementation((async (_broker: string, path: string) => (
      path === "/connect" ? connect() : { status: "connected" }
    )) as typeof apiClient.brokerRequest));
  }

  function codeFor(code: string) {
    return { connectUrl: `https://gloom.sh/connect/${code}`, code, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  }

  /** Records the profile work, and gives the config the broker's tab once the profile exists. */
  function brokerRegistry(
    storeRef: { current: AppContextStoreValue | null },
    record: { created: string[]; synced: string[] },
    sync: () => Promise<void> = async () => {},
  ) {
    return (registry: PluginRegistry) => {
      registry.createBrokerInstance = async (brokerType) => {
        record.created.push(brokerType);
        return PROFILE;
      };
      registry.syncBrokerInstance = async (instanceId) => {
        record.synced.push(instanceId);
        await sync();
      };
      registry.getConfig = () => {
        const config = storeRef.current!.getState().config;
        return record.created.length === 0 ? config : {
          ...config,
          brokerInstances: [PROFILE],
          portfolios: [...config.portfolios, { id: "broker:rh-1", name: "Robinhood", currency: "USD", brokerInstanceId: "rh-1" }],
        };
      };
    };
  }

  test("connects in the form, signing in to Gloom over it and trying a fresh code when Gloom refused the session", async () => {
    const notes: Array<{ body: string; type?: string }> = [];
    const storeRef: { current: AppContextStoreValue | null } = { current: null };
    const record = { created: [] as string[], synced: [] as string[] };
    let codeRequests = 0;
    fakeCloud({
      signedIn: () => true,
      connect: () => {
        codeRequests += 1;
        if (codeRequests === 1) throw new ApiRequestError("Session expired.", 401);
        return codeFor("K7QM");
      },
    });
    const user: AuthUser = {
      id: "u1",
      name: "Vince",
      email: "vince@example.com",
      username: null,
      emailVerified: true,
      image: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    spy(spyOn(apiClient, "startDeviceSignIn").mockResolvedValue({
      deviceCode: "device-1",
      userCode: "GLM1-ABCD",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      verificationUri: "https://gloom.sh/link/GLM1-ABCD",
      pollIntervalMs: 1_000,
    }));
    spy(spyOn(apiClient, "pollDeviceSignIn").mockResolvedValue({ status: "approved", sessionToken: "session-2", user }));
    spy(spyOn(chatController, "adoptSession").mockImplementation(() => {}));
    spy(spyOn(chatController, "refreshSession").mockResolvedValue());

    await renderForm(brokerRegistry(storeRef, record), { kind: "route", route: brokerRoute() }, { notes, storeRef });
    await waitForForm("Robinhood");
    await press(CTRL_S);

    // The first code request found the session gone: Gloom's sign-in opens over the form.
    await waitForFrameToContain("Approved as vince@example.com", 60);
    await press(ENTER);

    // A fresh attempt, with a controller of its own, asks for a new code.
    await waitForFrameToContain("K7QM");
    expect(frame()).toContain("Connect Robinhood");
    expect(frame()).toContain("Other AI apps linked to Robinhood get disconnected.");
    await waitForFrameToContain("Connected", 80);
    await press(ENTER);
    await settle();

    expect(codeRequests).toBe(2);
    expect(record).toEqual({ created: [SIGNED_IN_BROKER_TYPE], synced: ["rh-1"] });
    expect(notes).toEqual([{ body: "Connected! Positions will sync automatically.", type: "success" }]);
    expect(storeRef.current!.getState().paneState["portfolio-list:main"]?.collectionId).toBe("broker:rh-1");
    expect(frame()).not.toContain("Connect Robinhood");
  }, 15_000);

  test("backing out of Gloom's sign-in keeps the form; closing the connect step adds nothing", async () => {
    const notes: Array<{ body: string; type?: string }> = [];
    const storeRef: { current: AppContextStoreValue | null } = { current: null };
    const record = { created: [] as string[], synced: [] as string[] };
    let signedIn = false;
    fakeCloud({ signedIn: () => signedIn, connect: () => codeFor("K7QM") });
    spy(spyOn(apiClient, "startDeviceSignIn").mockImplementation(() => new Promise(() => {})));

    await renderForm(brokerRegistry(storeRef, record), { kind: "route", route: brokerRoute("manual") }, { notes, storeRef });
    await waitForForm("Portfolio Source");
    await press(ENTER);
    await waitForFrameToContain("▸ Manual");
    await press({ name: "down" }, ENTER);
    await waitForFrameToContain("Connect");
    // The pick moved on to the button, where Enter sends.
    await press(ENTER);
    await waitForFrameToContain("Sign in through your browser or scan the code");
    await press(ESC);
    await settle();
    expect(frame()).toContain("Portfolio Source");
    expect(frame()).toContain("Robinhood");
    expect(frame()).not.toContain("Connecting broker…");

    signedIn = true;
    await press(ENTER);
    await waitForFrameToContain("K7QM");
    await press(ESC);
    await settle();

    expect(frame()).not.toContain("K7QM");
    expect(frame()).not.toContain("Portfolio Source");
    expect(record.created).toEqual([]);
    expect(notes).toEqual([]);
    // The form is gone, so another can open.
    expect(openFormModal({ kind: "builtin", actionId: "new-layout" })).toBe(true);
  });

  test("a sync that fails once the broker connected stays in the form", async () => {
    const storeRef: { current: AppContextStoreValue | null } = { current: null };
    const record = { created: [] as string[], synced: [] as string[] };
    fakeCloud({ signedIn: () => true, connect: () => codeFor("K7QM") });

    await renderForm(brokerRegistry(storeRef, record, async () => {
      throw new Error("Robinhood did not answer.");
    }), { kind: "route", route: brokerRoute() }, { storeRef });
    await waitForForm("Robinhood");
    await press(CTRL_S);
    await waitForFrameToContain("Connected", 80);
    await press(ENTER);

    await waitForFrameToContain("Robinhood did not answer.");
    expect(frame()).toContain("New Portfolio");
    expect(record.synced).toEqual(["rh-1"]);
  }, 10_000);
});
