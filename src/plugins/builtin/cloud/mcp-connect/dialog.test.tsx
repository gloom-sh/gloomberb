import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { apiClient } from "../../../../api-client";
import { ApiRequestError } from "../../../../api-client/errors";
import { createOpenTuiTestHarness } from "../../../../renderers/opentui/test-utils";
import { blockExternalNetwork } from "../../../../test-support/network-guard";
import { Text, useRendererHost } from "../../../../ui";
import { AuthDialogHost } from "../auth-dialog";
import { McpConnectDialogHost, requestMcpConnectDialog } from "./dialog";
import { registerMcpConnectSection, type McpConnectSectionProps } from "./sections";

blockExternalNetwork();
const tui = createOpenTuiTestHarness();

const API_URL = "http://127.0.0.1:4555";
const CLAUDE = `claude mcp add --transport http gloom ${API_URL}/mcp`;
const KEY = "gloom_mcp_TESTKEY0123456789";

const original = {
  apiUrl: process.env.GLOOMBERB_API_URL,
  createMcpKey: apiClient.createMcpKey,
  recordResearchActivity: apiClient.recordResearchActivity,
  getCloudPricing: apiClient.getCloudPricing,
  getCloudAccountPlan: apiClient.getCloudAccountPlan,
};
let copied: string[] = [];
let opened: string[] = [];
let keyRequests: Array<{ name: string; scope: string }> = [];

beforeEach(() => {
  process.env.GLOOMBERB_API_URL = API_URL;
  copied = [];
  opened = [];
  keyRequests = [];
  apiClient.recordResearchActivity = (async () => {}) as typeof apiClient.recordResearchActivity;
  apiClient.getCloudPricing = (async () => { throw new Error("offline"); }) as typeof apiClient.getCloudPricing;
  apiClient.getCloudAccountPlan = (async () => { throw new Error("offline"); }) as typeof apiClient.getCloudAccountPlan;
});

afterEach(() => {
  if (original.apiUrl === undefined) delete process.env.GLOOMBERB_API_URL;
  else process.env.GLOOMBERB_API_URL = original.apiUrl;
  Object.assign(apiClient, {
    createMcpKey: original.createMcpKey,
    recordResearchActivity: original.recordResearchActivity,
    getCloudPricing: original.getCloudPricing,
    getCloudAccountPlan: original.getCloudAccountPlan,
  });
  apiClient.setSessionToken(null);
  apiClient.restoreCachedUser(null);
});

function signIn(plan: "free" | "pro"): void {
  apiClient.setSessionToken("mcp-connect-session");
  apiClient.restoreCachedUser({ id: `user-${plan}`, email: `${plan}@example.com`, emailVerified: true, plan });
}

function stubKeys(create: (input: { name: string; scope: string }) => Promise<unknown>): void {
  apiClient.createMcpKey = (async (input: { name: string; scope: string }) => {
    keyRequests.push(input);
    return create(input);
  }) as typeof apiClient.createMcpKey;
}

/** The shell's hosts, with the clipboard and the browser recorded. */
function Shell() {
  const renderer = useRendererHost();
  renderer.copyText = async (text: string) => {
    copied.push(text);
  };
  renderer.openExternal = async (url: string) => {
    opened.push(url);
  };
  return (
    <>
      <McpConnectDialogHost />
      <AuthDialogHost />
    </>
  );
}

async function openDialog(): Promise<void> {
  if (!tui.isMounted()) await tui.render(<Shell />, { width: 110, height: 48 });
  await act(async () => {
    expect(requestMcpConnectDialog()).toBe(true);
  });
  await tui.waitForFrameToContain("Connect an AI assistant");
}

const press = (name: string) => tui.emitKeypress({ name, sequence: name.length === 1 ? name : undefined });

describe("the Connect an AI assistant dialog", () => {
  test("shows each client's snippet for the configured endpoint, from the keyboard and the mouse", async () => {
    await openDialog();
    expect(tui.frame()).toContain(CLAUDE);

    await press("right");
    let frame = await tui.waitForFrameToContain(`codex mcp add gloom --url ${API_URL}/mcp`);
    expect(frame).toContain("Codex connects with a key.");

    await tui.clickFrameText("Cursor / JSON");
    frame = await tui.waitForFrameToContain(`"gloom": { "url": "${API_URL}/mcp" }`);

    await tui.clickFrameText("Other");
    frame = await tui.waitForFrameToContain("The endpoint.");
    expect(frame).not.toContain("mcpServers");
  });

  test("copies the snippet on screen with c, Enter or the Copy button", async () => {
    await openDialog();
    await press("c");
    await tui.waitForFrameToContain("Copied.");
    await press("right");
    await tui.clickFrameText("Copy ");
    await press("return");
    expect(copied).toHaveLength(3);
    expect(copied[0]).toBe(CLAUDE);
    expect(copied[1]).toStartWith("export GLOOM_MCP_KEY=gloom_mcp_...\ncodex mcp add gloom");
    expect(copied[2]).toBe(copied[1]!);
  });

  test("signed out, the key row is the existing sign-in, stacked over the dialog", async () => {
    stubKeys(async () => ({}));
    await openDialog();
    expect(tui.frame()).toContain("Sign in to Gloom Cloud");
    await press("k");
    await tui.waitForFrameToContain("Log in to Gloom Cloud");
    expect(keyRequests).toEqual([]);
  });

  test("without Pro, the key row points at the upgrade and creates nothing", async () => {
    signIn("free");
    stubKeys(async () => ({}));
    await openDialog();
    expect(tui.frame()).toContain("The MCP server is part of Gloom Pro.");
    await tui.clickFrameText("Upgrade to Pro");
    await tui.waitForFrameToContain("Not now");
    expect(keyRequests).toEqual([]);
  });

  test("with Pro, creates one key, fills it in everywhere and forgets it on close", async () => {
    signIn("pro");
    const created = Promise.withResolvers<unknown>();
    stubKeys(() => created.promise);
    await openDialog();

    // A held key must not mint a key per keypress.
    await press("k");
    await press("k");
    await tui.waitForFrameToContain("Creating...");
    await act(async () => {
      created.resolve({ token: KEY, apiKey: { id: "key-1", name: "Claude Code", scope: "read" } });
    });
    let frame = await tui.waitForFrameToContain("shown only once");
    expect(keyRequests).toEqual([{ name: "Claude Code", scope: "read" }]);
    expect(frame).toContain(`--header "Authorization: Bearer ${KEY}"`);

    await press("right");
    frame = await tui.waitForFrameToContain(`export GLOOM_MCP_KEY=${KEY}`);
    expect(frame).not.toContain("Codex connects with a key.");
    await press("k");
    await tui.waitForFrameToContain("Key copied.");
    expect(copied).toEqual([KEY]);

    await press("escape");
    await tui.waitForFrameToExclude("Connect an AI assistant");
    await openDialog();
    frame = tui.frame();
    expect(frame).not.toContain(KEY);
    expect(frame).toContain("Create a key");
    expect(keyRequests).toHaveLength(1);
  });

  test("a key that cannot be created says why in one line", async () => {
    signIn("pro");
    stubKeys(async () => { throw new TypeError("fetch failed"); });
    await openDialog();
    await press("k");
    await tui.waitForFrameToContain("Gloom Cloud can't be reached right now.");

    stubKeys(async () => { throw new ApiRequestError("The Gloom MCP server is part of Gloom Pro.", 402); });
    await press("k");
    await tui.waitForFrameToContain("Upgrade to Pro");
  });

  test("renders registered sections under the key row until they unregister", async () => {
    const unregister = registerMcpConnectSection({
      id: "terminal-control-test",
      Component: ({ width }: McpConnectSectionProps) => <Text>{`Terminal control section ${width}`}</Text>,
    });
    try {
      await openDialog();
      await tui.waitForFrameToContain("Terminal control section 78");
    } finally {
      act(() => unregister());
    }
    await tui.waitForFrameToExclude("Terminal control section");
  });
});
