import { afterEach, describe, expect, test } from "bun:test";
import { apiClient, setCloudApiFetchTransport } from "../../../api-client";
import { testRender } from "../../../renderers/opentui/test-utils";
import type { PluginRegistry } from "../../../plugins/registry";
import type { PaneTemplateCreateOptions } from "../../../types/plugin";
import {
  CommandBarHarness,
  createCommandBarTestControls,
  emitKeypress,
} from "./test-harness";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(() => {
  setCloudApiFetchTransport(null);
  apiClient.setSessionToken(null);
  if (testSetup) {
    testSetup.renderer.destroy();
    testSetup = undefined;
  }
});

const { waitForFrameToContain } = createCommandBarTestControls(() => testSetup!);

function signInVerified(): void {
  apiClient.setSessionToken("assist-test-token");
  apiClient.restoreCachedUser({
    id: "user-1",
    name: "Tester",
    email: "tester@example.com",
    username: "tester",
    emailVerified: true,
    plan: "free",
  } as never);
}

/**
 * Answers `/assist/command` locally and returns the asks that were made. Other
 * cloud calls are refused: ambient client traffic (a session refresh) must
 * never be mistaken for the bar asking a question.
 */
function mockAssistTransport(respond: (body: unknown) => Response | Promise<Response>): string[] {
  const requests: string[] = [];
  setCloudApiFetchTransport(async (url, init) => {
    if (!url.endsWith("/assist/command")) {
      throw new Error(`unexpected cloud request: ${url}`);
    }
    requests.push(url);
    return await respond(JSON.parse(String(init?.body ?? "{}")));
  });
  return requests;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Records pane creations and registers "ERN", an argless pane shortcut. */
function configureEarningsRegistry(
  created: Array<{ templateId: string; options?: PaneTemplateCreateOptions }>,
) {
  return (pluginRegistry: PluginRegistry) => {
    pluginRegistry.paneTemplates.set("earnings-calendar-pane", {
      id: "earnings-calendar-pane",
      paneId: "portfolio-list",
      label: "Earnings Calendar",
      description: "Upcoming earnings dates and estimates",
      shortcut: { prefix: "ERN" },
    } as never);
    (pluginRegistry as unknown as {
      createPaneFromTemplateAsyncFn: (templateId: string, options?: PaneTemplateCreateOptions) => Promise<void>;
    }).createPaneFromTemplateAsyncFn = async (templateId, options) => {
      created.push({ templateId, options });
    };
  };
}

/** Wide enough to cover the ask debounce plus the round trip. */
const ASSIST_WAIT_ATTEMPTS = 40;

async function waitForRequest(requests: string[]): Promise<void> {
  for (let attempt = 0; attempt < ASSIST_WAIT_ATTEMPTS; attempt++) {
    if (requests.length > 0) return;
    await Bun.sleep(50);
    await testSetup!.renderOnce();
  }
  throw new Error("Timed out waiting for the assist request.");
}

async function waitForFrameWithout(text: string): Promise<string> {
  for (let attempt = 0; attempt < ASSIST_WAIT_ATTEMPTS; attempt++) {
    const frame = testSetup!.captureCharFrame();
    if (!frame.includes(text)) return frame;
    await Bun.sleep(50);
    await testSetup!.renderOnce();
  }
  throw new Error(`Timed out waiting for "${text}" to disappear.`);
}

describe("CommandBar AI assist", () => {
  test("asks on its own, with no Enter, and answers below the local results", async () => {
    signInVerified();
    let sentCommandCount = 0;
    let releaseResponse = () => {};
    const held = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const requests = mockAssistTransport(async (body) => {
      sentCommandCount = (body as { commands: unknown[] }).commands.length;
      await held;
      return jsonResponse({
        candidates: [{ input: "CHAT #general", title: "Open the general channel", prefix: "CHAT", confidence: 0.9 }],
      });
    });
    const created: Array<{ templateId: string; options?: PaneTemplateCreateOptions }> = [];

    testSetup = await testRender(
      <CommandBarHarness
        query="open the general chat room"
        configurePluginRegistry={configureEarningsRegistry(created)}
      />,
      { width: 100, height: 20 },
    );

    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain("Thinking…");
    // Nobody pressed Enter; the debounce fires the one request by itself.
    await waitForRequest(requests);
    expect(requests).toHaveLength(1);
    expect(sentCommandCount).toBeGreaterThan(0);

    releaseResponse();
    const answered = await waitForFrameToContain("CHAT #general — Open the general channel", ASSIST_WAIT_ATTEMPTS);
    expect(answered).not.toContain("Thinking…");
    expect(requests).toHaveLength(1);

    await emitKeypress(testSetup, { name: "down" });
    await emitKeypress(testSetup, { name: "return", sequence: "\r" });
    expect(created).toEqual([{ templateId: "new-chat-pane", options: { arg: "#general" } }]);
  });

  test("leaves the selection on the local result an answer arrives under", async () => {
    signInVerified();
    mockAssistTransport(() => jsonResponse({
      candidates: [{ input: "CHAT #general", title: "Open the general channel", prefix: "CHAT", confidence: 0.9 }],
    }));
    const created: Array<{ templateId: string; options?: PaneTemplateCreateOptions }> = [];

    testSetup = await testRender(
      <CommandBarHarness
        query="new chat pane"
        configurePluginRegistry={configureEarningsRegistry(created)}
      />,
      { width: 100, height: 20 },
    );

    await testSetup.renderOnce();
    await waitForFrameToContain("CHAT #general — Open the general channel", ASSIST_WAIT_ATTEMPTS);

    // Enter without navigating still runs the local match that was selected
    // before the AI section grew underneath it.
    await emitKeypress(testSetup, { name: "return", sequence: "\r" });
    expect(created).toEqual([{ templateId: "new-chat-pane", options: undefined }]);
  });

  test("runs an argless prefix candidate that still carries an argument", async () => {
    signInVerified();
    // Unclamped on purpose: "ERN" takes no argument, so the client has to fall
    // back to the bare prefix instead of dropping the text into the input.
    mockAssistTransport(() => jsonResponse({
      candidates: [{ input: "ERN NVDA", title: "Earnings Calendar for NVDA", prefix: "ERN", confidence: 0.8 }],
    }));
    const created: Array<{ templateId: string; options?: PaneTemplateCreateOptions }> = [];

    testSetup = await testRender(
      <CommandBarHarness
        query="nvda earnings"
        configurePluginRegistry={configureEarningsRegistry(created)}
      />,
      { width: 100, height: 20 },
    );

    await testSetup.renderOnce();
    await waitForFrameToContain("ERN NVDA — Earnings Calendar for NVDA", ASSIST_WAIT_ATTEMPTS);

    await emitKeypress(testSetup, { name: "down" });
    await emitKeypress(testSetup, { name: "return", sequence: "\r" });
    expect(created).toEqual([{ templateId: "earnings-calendar-pane", options: undefined }]);
  });

  test("drops the section when a background ask fails", async () => {
    signInVerified();
    const requests = mockAssistTransport(() => jsonResponse({ error: "assist-unavailable" }, 503));

    testSetup = await testRender(
      <CommandBarHarness query="show me the newest filings" />,
      { width: 100, height: 20 },
    );

    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain("Ask AI");

    const frame = await waitForFrameWithout("Ask AI");
    expect(requests).toHaveLength(1);
    expect(frame).not.toContain("unavailable");
  });

  test("sends signed-out users to sign up instead of the endpoint", async () => {
    const requests = mockAssistTransport(() => jsonResponse({ candidates: [] }));

    testSetup = await testRender(
      <CommandBarHarness query="chart nvidia vs amd" />,
      { width: 100, height: 20 },
    );

    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain("Ask AI — sign up to enable");

    await Bun.sleep(700);
    await testSetup.renderOnce();
    expect(requests).toEqual([]);
  });
});
