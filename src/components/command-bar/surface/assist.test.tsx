import { afterEach, describe, expect, test } from "bun:test";
import { apiClient, setCloudApiFetchTransport } from "../../../api-client";
import { testRender } from "../../../renderers/opentui/test-utils";
import type { PluginRegistry } from "../../../plugins/registry";
import type { PaneTemplateCreateOptions } from "../../../types/plugin";
import {
  CommandBarHarness,
  createCommandBarTestControls,
  emitKeypress,
  settleFrame,
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
/**
 * A budget, not a poll count. The ask waits out a 600ms debounce before it even
 * reaches the transport, and on a loaded CI runner the renders in between cost
 * far more than the sleeps, which is what made these tests fail in batches.
 */
const ASSIST_WAIT_MS = 10_000;
/**
 * Above `ASSIST_WAIT_MS`, because Bun's own per-test timeout is 5s and a wait
 * budget the runner kills first is not a budget. These tests sit out a 600ms
 * debounce and a round trip, so they need the room on a slow machine.
 */
const ASSIST_TEST_TIMEOUT_MS = 20_000;

async function waitForRequest(requests: string[]): Promise<void> {
  const deadline = Date.now() + ASSIST_WAIT_MS;
  do {
    if (requests.length > 0) return;
    await settleFrame(testSetup!);
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for the assist request.");
}

async function waitForFrameWithout(text: string): Promise<string> {
  const deadline = Date.now() + ASSIST_WAIT_MS;
  do {
    const frame = testSetup!.captureCharFrame();
    if (!frame.includes(text)) return frame;
    await settleFrame(testSetup!);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for "${text}" to disappear.`);
}

describe("CommandBar AI assist", () => {
  test("asks on its own, with no Enter, and leads the list with the answer", async () => {
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
        query="new chat pane"
        configurePluginRegistry={configureEarningsRegistry(created)}
      />,
      // Wide enough for the answer's label and its title to share one row.
      { width: 120, height: 20 },
    );

    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain("Thinking…");
    // Nobody pressed Enter; the debounce fires the one request by itself.
    await waitForRequest(requests);
    expect(requests).toHaveLength(1);
    expect(sentCommandCount).toBeGreaterThan(0);

    releaseResponse();
    const answered = await waitForFrameToContain("#general · Open the general channel", ASSIST_WAIT_ATTEMPTS);
    expect(answered).not.toContain("Thinking…");
    expect(requests).toHaveLength(1);
    // Above the local matches, laid out like any other row with the prefix in
    // the badge column, and holding the selection an untouched query never
    // moved: plain Enter runs the AI's best guess.
    expect(answered.indexOf("Ask AI")).toBeLessThan(answered.indexOf("Panes"));
    expect(answered).toMatch(/CHAT\s+#general · Open the general channel/);

    await emitKeypress(testSetup, { name: "return", sequence: "\r" });
    expect(created).toEqual([{ templateId: "new-chat-pane", options: { arg: "#general" } }]);
  }, ASSIST_TEST_TIMEOUT_MS);

  test("keeps the row the user picked when an answer lands above it", async () => {
    signInVerified();
    let releaseResponse = () => {};
    const held = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const requests = mockAssistTransport(async () => {
      await held;
      return jsonResponse({
        candidates: [
          { input: "CHAT #general", title: "Open the general channel", prefix: "CHAT", confidence: 0.9 },
          { input: "CHAT #random", title: "Open the random channel", prefix: "CHAT", confidence: 0.4 },
        ],
      });
    });
    const created: Array<{ templateId: string; options?: PaneTemplateCreateOptions }> = [];

    testSetup = await testRender(
      <CommandBarHarness
        query="new chat pane"
        configurePluginRegistry={configureEarningsRegistry(created)}
      />,
      // Wide enough for the answers' labels and titles to share one row.
      { width: 120, height: 20 },
    );

    await testSetup.renderOnce();
    await waitForRequest(requests);
    // Down lands on the local match while a single "Thinking…" row sits above.
    await emitKeypress(testSetup, { name: "down" });
    releaseResponse();
    await waitForFrameToContain("#random · Open the random channel", ASSIST_WAIT_ATTEMPTS);

    // Two answers replaced that one row, so the chosen row moved down by one;
    // Enter still runs it rather than whatever now sits at its old index.
    await emitKeypress(testSetup, { name: "return", sequence: "\r" });
    expect(created).toEqual([{ templateId: "new-chat-pane", options: undefined }]);
  }, ASSIST_TEST_TIMEOUT_MS);

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
    await waitForFrameToContain("NVDA · Earnings Calendar", ASSIST_WAIT_ATTEMPTS);

    await emitKeypress(testSetup, { name: "return", sequence: "\r" });
    expect(created).toEqual([{ templateId: "earnings-calendar-pane", options: undefined }]);
  }, ASSIST_TEST_TIMEOUT_MS);

  test("claims the answer still in flight when Enter lands on the thinking row", async () => {
    signInVerified();
    let releaseResponse = () => {};
    const held = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const requests = mockAssistTransport(async () => {
      await held;
      return jsonResponse({
        candidates: [{ input: "CHAT #general", title: "Open the general channel", prefix: "CHAT", confidence: 0.9 }],
      });
    });
    const created: Array<{ templateId: string; options?: PaneTemplateCreateOptions }> = [];

    testSetup = await testRender(
      <CommandBarHarness
        query="new chat pane"
        configurePluginRegistry={configureEarningsRegistry(created)}
      />,
      { width: 100, height: 20 },
    );

    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain("Thinking…");

    // Enter on "Thinking…" is a promise, not a dead key: there is nothing to
    // run yet, so the ask is claimed and its answer runs when it arrives.
    await emitKeypress(testSetup, { name: "return", sequence: "\r" });
    expect(created).toEqual([]);

    releaseResponse();
    const deadline = Date.now() + ASSIST_WAIT_MS;
    while (created.length === 0 && Date.now() < deadline) {
      await settleFrame(testSetup);
    }
    expect(created).toEqual([{ templateId: "new-chat-pane", options: { arg: "#general" } }]);
    expect(requests).toHaveLength(1);
  }, ASSIST_TEST_TIMEOUT_MS);

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
  }, ASSIST_TEST_TIMEOUT_MS);

  test("sends signed-out users to sign up instead of the endpoint", async () => {
    const requests = mockAssistTransport(() => jsonResponse({ candidates: [] }));
    const created: Array<{ templateId: string; options?: PaneTemplateCreateOptions }> = [];

    testSetup = await testRender(
      <CommandBarHarness
        query="new chat pane"
        configurePluginRegistry={configureEarningsRegistry(created)}
      />,
      { width: 100, height: 20 },
    );

    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain("Ask AI — sign up to enable");

    await settleFrame(testSetup, 700);
    expect(requests).toEqual([]);

    // The offer sits under the list and never takes the Enter that belongs to
    // the local match the user was already looking at.
    await emitKeypress(testSetup, { name: "return", sequence: "\r" });
    expect(created).toEqual([{ templateId: "new-chat-pane", options: undefined }]);
  }, ASSIST_TEST_TIMEOUT_MS);
});
