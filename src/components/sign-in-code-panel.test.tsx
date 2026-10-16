import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { apiClient } from "../api-client";
import { DeviceSignInDialogHost, requestDeviceSignInDialog } from "../account/device-signin-dialog";
import type { SignedInBroker } from "../brokers/signed-in/client";
import { BrokerSignInDialogHost, brokerSignInNote, requestBrokerSignIn } from "../brokers/signed-in/sign-in-dialog";
import { createOpenTuiTestHarness, TestDialogProvider } from "../renderers/opentui/test-utils";
import { desktopQrModulePx } from "./sign-in-code-panel";

// A connect link's code: 41 modules across, the 4-module quiet zone included.
const MODULES = 41;

describe("desktopQrModulePx", () => {
  test("draws modules in whole pixels a quarter of a row, and follows the text size", () => {
    expect(desktopQrModulePx(MODULES, 10_000, 18)).toBe(4);
    expect(desktopQrModulePx(MODULES, 10_000, 27)).toBe(6);
  });

  test("shrinks to whole pixels that fit, and gives up below what a camera reads", () => {
    expect(desktopQrModulePx(MODULES, MODULES * 3 + 2, 18)).toBe(3);
    expect(desktopQrModulePx(MODULES, MODULES * 3 - 1, 18)).toBeNull();
  });
});

const BROKER = {
  id: "ibkr",
  name: "Interactive Brokers",
  capabilities: { history: true, executions: true, orders: null, singleConnection: true },
} as unknown as SignedInBroker;
const CONNECT_URL = "https://gloom.sh/connect/test-ticket";
const NOTE = brokerSignInNote(BROKER)!;
const future = () => new Date(Date.now() + 10 * 60_000).toISOString();

describe("in the terminal", () => {
  const tui = createOpenTuiTestHarness({ width: 90, height: 40 });
  const spies: Array<{ mockRestore(): void }> = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  async function settle() {
    for (let index = 0; index < 4; index += 1) {
      await act(async () => { await Bun.sleep(20); });
      await tui.setup().renderOnce();
    }
  }

  async function connect(code?: string) {
    const bodies: unknown[] = [];
    spies.push(spyOn(apiClient, "isSignedIn").mockReturnValue(true));
    spies.push(spyOn(apiClient, "brokerRequest").mockImplementation(async (_broker: string, path: string, options?: { body?: unknown }) => {
      if (path === "/connect") {
        bodies.push(options?.body);
        return { connectUrl: CONNECT_URL, ...(code ? { code } : {}), expiresAt: future() } as never;
      }
      return { status: "not_connected" } as never;
    }));
    await tui.render(<TestDialogProvider><BrokerSignInDialogHost /></TestDialogProvider>);
    await act(async () => { void requestBrokerSignIn(BROKER); });
    await tui.waitForFrameToContain("Waiting for Interactive Brokers", 40);
    await settle();
    const lines = tui.frame().split("\n");
    const qrEnd = lines.findLastIndex((line) => /[█▀▄]/.test(line));
    const urlAt = lines.findIndex((line) => line.includes(CONNECT_URL));
    // What the dialog shows between the QR code and the link.
    const between = lines.slice(qrEnd + 1, urlAt).map((line) => line.replace(/[│\s]+/g, " ").trim()).filter(Boolean);
    return { bodies, lines, between };
  }

  test("a broker connect asks Gloom for no code, shows none, and wraps the note inside the dialog", async () => {
    const { bodies, lines, between } = await connect();
    expect(bodies).toEqual([{ write: false, code: false }]);
    expect(between).toEqual([]);
    // The note wraps to the dialog, every word of it, instead of running off its edge.
    const noteAt = lines.findIndex((line) => line.includes(NOTE.slice(0, 12)));
    const note = lines.slice(noteAt, noteAt + 3).map((line) => line.replace(/[│\s]+/g, " ").trim()).join(" ");
    expect(note).toContain(NOTE);
  });

  test("a Gloom Cloud that still hands out a code gets it shown", async () => {
    const { between } = await connect("K7QX");
    expect(between).toEqual(["K7QX"]);
  });

  test("Gloom's sign-in shows its code as plain text, not drawn in block letters", async () => {
    spies.push(spyOn(apiClient, "startDeviceSignIn").mockResolvedValue({
      deviceCode: "device-1",
      userCode: "ABCD-1234",
      expiresAt: future(),
      verificationUri: "https://gloom.sh/link/ABCD-1234",
      pollIntervalMs: 600_000,
    } as never));
    spies.push(spyOn(apiClient, "pollDeviceSignIn").mockResolvedValue({ status: "pending" } as never));

    await tui.render(<TestDialogProvider><DeviceSignInDialogHost /></TestDialogProvider>);
    await act(async () => { requestDeviceSignInDialog(); });
    await tui.waitForFrameToContain("Waiting for approval", 40);
    await settle();

    const lines = tui.frame().split("\n");
    const codeLines = lines.filter((line) => line.includes("ABCD-1234"));
    // Once on its own row and once in the link under it.
    expect(codeLines).toHaveLength(2);
    expect(codeLines[0]!.trim().replace(/^│\s*|\s*│$/g, "")).toBe("ABCD-1234");
  });
});
