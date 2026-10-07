/** @jsxImportSource react */
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { act } from "react";
import { apiClient } from "../../../api-client";
import { InputHostProvider, type InputHost } from "../../../react/input";
import { createDomTestHarness } from "../../../renderers/dom/test-utils";
import { setAppVisible } from "../../../state/app/activity";
import { createStatefulTestPluginRuntime, createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { getCurrentPluginTarget, setCurrentPluginTarget } from "../../current-target";
import { PluginRenderProvider } from "../../runtime";
import type { CommandDef, GloomPluginContext } from "../../../types/plugin";
import {
  registerTrialOfferCommand,
  TRIAL_OFFER_EXPERIMENT,
  TrialOfferStatusWidget,
} from "./trial-offer-status-widget";

const { render } = createDomTestHarness();
const DELAY_MS = 15_000;
const previousTarget = getCurrentPluginTarget();
const originalPricing = apiClient.getCloudPricing;
const inputHost: InputHost = {
  useShortcut() {},
  useViewport: () => ({ width: 160, height: 40 }),
};

function Widget(props: Parameters<typeof TrialOfferStatusWidget>[0] & { runtime?: ReturnType<typeof createTestPluginRuntime> }) {
  const { runtime = createTestPluginRuntime(), ...rest } = props;
  return (
    <InputHostProvider host={inputHost}>
      <PluginRenderProvider pluginId="gloomberb-cloud" runtime={runtime}>
        <TrialOfferStatusWidget {...rest} />
      </PluginRenderProvider>
    </InputHostProvider>
  );
}

async function mount(arm: string | null) {
  const asked: string[] = [];
  const expose = async (experiment: string) => {
    asked.push(experiment);
    return arm;
  };
  const container = await render(<Widget expose={expose} delayMs={DELAY_MS} />);
  return { asked, container };
}

async function pass(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  // The arm and the trial length resolve as promises after the timer fires.
  await act(async () => {
    await Promise.resolve();
  });
}

describe("TrialOfferStatusWidget", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    setCurrentPluginTarget("web");
    setAppVisible(true);
    apiClient.restoreCachedUser(null);
    apiClient.getCloudPricing = async () => ({
      currency: "usd",
      trialDays: 7,
      monthly: { amount: 2000 },
      yearly: { amount: 18000 },
    } as Awaited<ReturnType<typeof apiClient.getCloudPricing>>);
  });

  afterEach(async () => {
    jest.useRealTimers();
    // Still mounted here: the harness unmounts after this hook.
    await act(async () => {
      setAppVisible(true);
      apiClient.setSessionToken(null);
      apiClient.restoreCachedUser(null);
    });
    setCurrentPluginTarget(previousTarget);
    apiClient.getCloudPricing = originalPricing;
  });

  test("asks for the arm once the terminal has been on screen long enough, not counting hidden time", async () => {
    const { asked, container } = await mount("offer");
    await pass(DELAY_MS - 5_000);
    await act(async () => setAppVisible(false));
    await pass(60_000);
    expect(asked).toEqual([]);

    await act(async () => setAppVisible(true));
    await pass(4_000);
    expect(asked).toEqual([]);
    await pass(1_000);
    expect(asked).toEqual([TRIAL_OFFER_EXPERIMENT]);
    expect(container.textContent).toContain("7 days free");
  });

  test("the control arm is counted the same way and shows nothing", async () => {
    const { asked, container } = await mount("control");
    await pass(DELAY_MS);
    expect(asked).toEqual([TRIAL_OFFER_EXPERIMENT]);
    expect(container.textContent).toBe("");
  });

  test("signed-in accounts, Free or Pro, are never asked and never see it", async () => {
    for (const plan of ["free", "pro"] as const) {
      await act(async () => {
        apiClient.setSessionToken("session");
        apiClient.restoreCachedUser({ id: `user-${plan}`, emailVerified: true, plan });
      });
      const { asked, container } = await mount("offer");
      await pass(DELAY_MS * 2);
      expect(asked).toEqual([]);
      expect(container.textContent).toBe("");
    }
  });

  test("hiding it from the command bar keeps it away on the next visit", async () => {
    let hideCommand: CommandDef | undefined;
    registerTrialOfferCommand({
      registerCommand: (command: CommandDef) => {
        hideCommand = command;
      },
    } as unknown as GloomPluginContext);
    expect(hideCommand?.hidden?.()).toBe(true);

    const runtime = createStatefulTestPluginRuntime();
    const first = await render(<Widget runtime={runtime} expose={async () => "offer"} delayMs={DELAY_MS} />);
    await pass(DELAY_MS);
    expect(first.textContent).toContain("7 days free");
    expect(hideCommand?.hidden?.()).toBe(false);
    await act(async () => {
      await hideCommand?.execute();
    });
    expect(first.textContent).toBe("");
    expect(hideCommand?.hidden?.()).toBe(true);

    const next = await render(<Widget runtime={runtime} expose={async () => "offer"} delayMs={DELAY_MS} />);
    await pass(DELAY_MS);
    expect(next.textContent).toBe("");
  });
});
