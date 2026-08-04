import { afterEach, describe, expect, test } from "bun:test";
import { apiClient, setCloudApiFetchTransport } from "../../../api-client";
import { testRender } from "../../../renderers/opentui/test-utils";
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

/** Answers `/assist/command` locally; any other cloud call fails the test. */
function mockAssistTransport(respond: (body: unknown) => Response): string[] {
  const requests: string[] = [];
  setCloudApiFetchTransport(async (url, init) => {
    requests.push(url);
    if (!url.endsWith("/assist/command")) {
      throw new Error(`unexpected cloud request: ${url}`);
    }
    return respond(JSON.parse(String(init?.body ?? "{}")));
  });
  return requests;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("CommandBar AI assist", () => {
  test("resolves a natural-language query into a runnable command", async () => {
    signInVerified();
    let sentCommandCount = 0;
    const requests = mockAssistTransport((body) => {
      sentCommandCount = (body as { commands: unknown[] }).commands.length;
      return jsonResponse({
        candidates: [{ input: "CHAT #general", title: "Open the general channel", prefix: "CHAT", confidence: 0.9 }],
      });
    });
    const created: Array<{ templateId: string; options?: PaneTemplateCreateOptions }> = [];

    testSetup = await testRender(
      <CommandBarHarness
        query="open the general chat room"
        configurePluginRegistry={(pluginRegistry) => {
          (pluginRegistry as unknown as {
            createPaneFromTemplateAsyncFn: (templateId: string, options?: PaneTemplateCreateOptions) => Promise<void>;
          }).createPaneFromTemplateAsyncFn = async (templateId, options) => {
            created.push({ templateId, options });
          };
        }}
      />,
      { width: 100, height: 20 },
    );

    await testSetup.renderOnce();
    // Nothing is requested while typing.
    expect(requests).toEqual([]);
    expect(testSetup.captureCharFrame()).toContain('Ask AI: "open the general chat room"');

    await emitKeypress(testSetup, { name: "return", sequence: "\r" });
    const answered = await waitForFrameToContain("CHAT #general — Open the general channel");
    expect(answered).not.toContain('Ask AI: "open');
    expect(requests).toHaveLength(1);
    expect(sentCommandCount).toBeGreaterThan(0);

    await emitKeypress(testSetup, { name: "return", sequence: "\r" });
    expect(created).toEqual([{ templateId: "new-chat-pane", options: { arg: "#general" } }]);
  });

  test("reports assist outages inline and lets Esc restore the normal list", async () => {
    signInVerified();
    mockAssistTransport(() => jsonResponse({ error: "assist-unavailable" }, 503));

    testSetup = await testRender(
      <CommandBarHarness query="show me the newest filings" />,
      { width: 100, height: 20 },
    );

    await testSetup.renderOnce();
    await emitKeypress(testSetup, { name: "return", sequence: "\r" });
    await waitForFrameToContain("AI assist unavailable");

    await emitKeypress(testSetup, { name: "escape" });
    await waitForFrameToContain('Ask AI: "show me the newest filings"');
  });

  test("sends signed-out users to sign up instead of the endpoint", async () => {
    const requests = mockAssistTransport(() => jsonResponse({ candidates: [] }));

    testSetup = await testRender(
      <CommandBarHarness query="chart nvidia vs amd" />,
      { width: 100, height: 20 },
    );

    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain("Ask AI — sign up to enable");

    await emitKeypress(testSetup, { name: "return", sequence: "\r" });
    expect(requests).toEqual([]);
  });
});
