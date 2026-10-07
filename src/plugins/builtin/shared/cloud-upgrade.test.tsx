import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { act, useState } from "react";
import { apiClient } from "../../../api-client";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { useRendererHost } from "../../../ui";
import { openCloudUpgradeUrl, resetCloudUpgradeGuardForTests, useCloudUpgradeAction } from "./cloud-upgrade";

const tui = createOpenTuiTestHarness();

const originalCreateCloudCheckout = apiClient.createCloudCheckout;
const originalCreateBrowserHandoff = apiClient.createBrowserHandoff;
const originalRecordResearchActivity = apiClient.recordResearchActivity;
let checkouts = 0;
let opened: string[] = [];

beforeEach(() => {
  checkouts = 0;
  opened = [];
  apiClient.recordResearchActivity = (async () => {}) as typeof apiClient.recordResearchActivity;
  apiClient.setSessionToken("cloud-upgrade-session");
  apiClient.restoreCachedUser({ id: "user-free", email: "free@example.com", emailVerified: true, plan: "free" });
});

afterEach(() => {
  apiClient.createCloudCheckout = originalCreateCloudCheckout;
  apiClient.createBrowserHandoff = originalCreateBrowserHandoff;
  apiClient.recordResearchActivity = originalRecordResearchActivity;
  apiClient.setSessionToken(null);
  apiClient.restoreCachedUser(null);
  setSystemTime();
  resetCloudUpgradeGuardForTests();
});

function Prompt({ placement }: { placement: string }) {
  useCloudUpgradeAction(placement);
  return null;
}

/** Mounts onboarding's Pro step action, with the browser tabs it opens recorded. */
async function renderUpgradeAction(): Promise<(options?: unknown) => Promise<void>> {
  let upgrade!: (options?: unknown) => Promise<void>;
  function ProStep() {
    upgrade = useCloudUpgradeAction("onboarding-pro");
    useRendererHost().openExternal = async (url: string) => {
      opened.push(url);
    };
    return null;
  }
  await tui.render(<ProStep />);
  return upgrade;
}

test("a held Enter opens one checkout, and another only once a few seconds have passed", async () => {
  const created = Promise.withResolvers<{ url: string }>();
  apiClient.createCloudCheckout = (async () => {
    checkouts += 1;
    return created.promise;
  }) as typeof apiClient.createCloudCheckout;
  const upgrade = await renderUpgradeAction();
  let opening = 0;
  const press = () => upgrade({ sheet: false, onOpening: () => { opening += 1; } });

  const held = [press(), press(), press()];
  created.resolve({ url: "https://checkout.example/session" });
  await Promise.all(held);
  await press();
  expect(checkouts).toBe(1);
  expect(opened).toEqual(["https://checkout.example/session"]);
  // Onboarding stamps checkoutOpenedAt here, so a repeat must not reach it.
  expect(opening).toBe(1);

  setSystemTime(new Date(Date.now() + 3_500));
  await press();
  expect(checkouts).toBe(2);
  expect(opened).toHaveLength(2);
});

test("a checkout still opening after 30 seconds lets the next press try again", async () => {
  const hung = [Promise.withResolvers<{ url: string }>(), Promise.withResolvers<{ url: string }>()];
  apiClient.createCloudCheckout = (async () => {
    checkouts += 1;
    return hung[checkouts - 1]!.promise;
  }) as typeof apiClient.createCloudCheckout;
  const upgrade = await renderUpgradeAction();
  const start = Date.now();

  const first = upgrade({ sheet: false });
  setSystemTime(new Date(start + 29_000));
  await upgrade({ sheet: false });
  expect(checkouts).toBe(1);

  setSystemTime(new Date(start + 31_000));
  const second = upgrade({ sheet: false });
  expect(checkouts).toBe(2);

  // The stale first call finishing must not cut the second one's block short.
  hung[0]!.resolve({ url: "https://checkout.example/late" });
  await first;
  setSystemTime(new Date(start + 35_000));
  await upgrade({ sheet: false });
  expect(checkouts).toBe(2);

  hung[1]!.resolve({ url: "https://checkout.example/session" });
  await second;
  expect(opened).toEqual(["https://checkout.example/late", "https://checkout.example/session"]);
});

test("a checkout that cannot be created falls back to the Cloud page once and lets a retry through", async () => {
  let failing = true;
  apiClient.createCloudCheckout = (async () => {
    checkouts += 1;
    if (failing) throw new Error("Stripe is unavailable");
    return { url: "https://checkout.example/session" };
  }) as typeof apiClient.createCloudCheckout;
  apiClient.createBrowserHandoff = (async () => ({ url: "https://gloom.sh/cloud?handoff=one-time" })) as typeof apiClient.createBrowserHandoff;
  const upgrade = await renderUpgradeAction();

  await upgrade({ sheet: false });
  await upgrade({ sheet: false });
  expect(checkouts).toBe(2);
  // The second failure comes within seconds of the first Cloud page tab.
  expect(opened).toEqual(["https://gloom.sh/cloud?handoff=one-time"]);

  failing = false;
  await upgrade({ sheet: false });
  expect(checkouts).toBe(3);
  expect(opened).toEqual(["https://gloom.sh/cloud?handoff=one-time", "https://checkout.example/session"]);
});

test("the UPGRADE command still opens checkout after the newest prompt closes", async () => {
  apiClient.setSessionToken(null);
  apiClient.restoreCachedUser(null);
  let showFooter!: (shown: boolean) => void;
  function Prompts() {
    const [footer, setFooter] = useState(true);
    showFooter = setFooter;
    return (
      <>
        <Prompt placement="status-widget" />
        {footer ? <Prompt placement="news-footer" /> : null}
      </>
    );
  }
  await tui.render(<Prompts />);
  await act(async () => {
    showFooter(false);
    await tui.setup().renderOnce();
  });
  // Signed out, the remaining opener sends the person to the Cloud page; what
  // matters is that the command did not fall back to the account pane.
  expect(openCloudUpgradeUrl("command")).toBe(true);
  await tui.destroy();
  expect(openCloudUpgradeUrl("command")).toBe(false);
});
