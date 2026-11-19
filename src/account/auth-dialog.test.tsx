import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { apiClient, type AuthUser } from "../api-client";
import { chatController } from "../plugins/builtin/chat/controller";
import { createOpenTuiTestHarness } from "../renderers/opentui/test-utils";
import { blockExternalNetwork } from "../test-support/network-guard";
import { AuthDialogHost, isAuthDialogOpen, requestAuthDialog, requestEmailConfirmation } from "./auth-dialog";
import { heardFromDueAccount, takeHeardFromDue } from "./heard-from";
import { resetVerificationCooldownForTests } from "./verification-panel";

blockExternalNetwork();
const tui = createOpenTuiTestHarness();

async function openSignUp(): Promise<string> {
  await tui.render(<AuthDialogHost />, { width: 100, height: 40 });
  await act(async () => {
    expect(requestAuthDialog({ mode: "signup", reason: "Stock quotes are 15 min delayed without Pro." })).toBe(true);
  });
  return tui.waitForFrameToContain("Create your free Gloom Cloud account");
}

async function clickClose(title: string): Promise<void> {
  const rows = tui.frame().split("\n");
  const titleRow = rows.findIndex((line) => line.includes(title));
  const closeCol = rows[titleRow]!.lastIndexOf(" x ") + 1;
  expect(closeCol).toBeGreaterThan(0);
  await act(async () => {
    await tui.setup().mockMouse.click(closeCol, titleRow);
  });
}

async function clickOutside(): Promise<void> {
  await act(async () => {
    await tui.setup().mockMouse.click(1, 1);
    await tui.setup().renderOnce();
  });
}

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

// A mouse alone must close the sign-up dialog the delayed mark opens: it had no close button and ignored a click
// outside, so only Esc closed it.
describe("sign-up dialog", () => {
  test("closes from its close button, and says what is delayed", async () => {
    const frame = await openSignUp();
    expect(frame).toContain("Stock quotes are 15 min delayed without Pro.");
    const rows = frame.split("\n");
    const titleRow = rows.findIndex((line) => line.includes("Create your free Gloom Cloud account"));
    const closeCol = rows[titleRow]!.lastIndexOf(" x ") + 1;
    expect(closeCol).toBeGreaterThan(0);
    await act(async () => {
      await tui.setup().mockMouse.click(closeCol, titleRow);
    });
    await tui.waitForFrameToExclude("Create your free Gloom Cloud account");
    expect(isAuthDialogOpen()).toBe(false);
  });

  test("closes on a click outside it while nothing is typed in it", async () => {
    await openSignUp();
    await clickOutside();
    await tui.waitForFrameToExclude("Create your free Gloom Cloud account");
    expect(isAuthDialogOpen()).toBe(false);
  });

  test("keeps what is typed from a stray click outside, and still closes from its close button", async () => {
    await openSignUp();
    await act(async () => {
      await tui.setup().mockInput.typeText("ana@example.com");
      await tui.setup().renderOnce();
    });
    await tui.waitForFrameToContain("ana@example.com");
    await clickOutside();
    expect(tui.frame()).toContain("ana@example.com");
    expect(isAuthDialogOpen()).toBe(true);
    await clickClose("Create your free Gloom Cloud account");
    await tui.waitForFrameToExclude("Create your free Gloom Cloud account");
    expect(isAuthDialogOpen()).toBe(false);
  });

  test("stays open on a click outside while the account waits on its confirmation email", async () => {
    const user = { id: "u1", email: "ana@example.com", emailVerified: false } as AuthUser;
    spies.push(
      spyOn(apiClient, "signUp").mockResolvedValue(user),
      spyOn(apiClient, "getCurrentUser").mockReturnValue(user),
      spyOn(apiClient, "getSessionToken").mockReturnValue(null),
      spyOn(apiClient, "sendVerification").mockResolvedValue(undefined as never),
      spyOn(apiClient, "getSession").mockResolvedValue(user),
      spyOn(chatController, "refreshSession").mockResolvedValue(undefined as never),
    );
    await openSignUp();
    for (const step of [
      () => tui.setup().mockInput.typeText("ana@example.com"),
      () => tui.setup().mockInput.pressTab(),
      () => tui.setup().mockInput.typeText("correct horse battery"),
      () => tui.setup().mockInput.pressEnter(),
    ]) {
      await act(async () => {
        await step();
        await tui.setup().renderOnce();
      });
    }
    await tui.waitForFrameToContain("Confirm ana@example.com");
    await clickOutside();
    expect(tui.frame()).toContain("Confirm ana@example.com");
    expect(isAuthDialogOpen()).toBe(true);
    await clickClose("Confirm ana@example.com");
    await tui.waitForFrameToExclude("Confirm ana@example.com");
    expect(isAuthDialogOpen()).toBe(false);
    // The account exists: closing before confirming still asks where it heard about Gloom.
    expect(heardFromDueAccount()).toBe("u1");
    takeHeardFromDue("u1");
  });
});

// "verify your email" in the status bar and a wall's Resend Verification Email both end here: the link goes out
// again and the dialog names the address it went to. They used to send it with only a toast to show for it.
describe("coming back to confirm an email", () => {
  const user = { id: "u2", email: "ana@example.com", emailVerified: false } as AuthUser;

  function signedInAs(account: AuthUser | null) {
    const send = spyOn(apiClient, "sendVerification").mockResolvedValue(undefined as never);
    spies.push(
      send,
      spyOn(apiClient, "getCurrentUser").mockReturnValue(account),
      spyOn(apiClient, "getSession").mockResolvedValue(account),
    );
    return send;
  }

  test("sends the link once and opens on the address it went to", async () => {
    resetVerificationCooldownForTests();
    const send = signedInAs(user);
    await tui.render(<AuthDialogHost />, { width: 100, height: 40 });
    await act(async () => {
      expect(requestEmailConfirmation()).toBe(true);
    });
    await tui.waitForFrameToContain("Confirm ana@example.com");
    await tui.waitForFrameToContain("Confirmation link sent");
    expect(send).toHaveBeenCalledTimes(1);

    // Closed and pressed again within the minute: the dialog comes back, no second email goes out.
    await clickClose("Confirm ana@example.com");
    await tui.waitForFrameToExclude("Confirm ana@example.com");
    await act(async () => {
      expect(requestEmailConfirmation()).toBe(true);
    });
    const again = await tui.waitForFrameToContain("Confirm ana@example.com");
    expect(again).toContain("Email sent");
    expect(send).toHaveBeenCalledTimes(1);
    await clickClose("Confirm ana@example.com");
    await tui.waitForFrameToExclude("Confirm ana@example.com");
    // It signed up earlier; coming back to confirm is not a sign-up.
    expect(heardFromDueAccount()).toBeNull();
  });

  test("opens nothing for a confirmed account or no account, so the caller falls back", async () => {
    await tui.render(<AuthDialogHost />, { width: 100, height: 40 });
    signedInAs({ ...user, emailVerified: true });
    expect(requestEmailConfirmation()).toBe(false);
    for (const spy of spies.splice(0)) spy.mockRestore();
    signedInAs(null);
    expect(requestEmailConfirmation()).toBe(false);
    expect(isAuthDialogOpen()).toBe(false);
  });
});

// "Where did you hear about Gloom?" follows a sign-up from this dialog, never one on its way to a checkout.
describe("the question after a sign-up", () => {
  afterEach(() => {
    const due = heardFromDueAccount();
    if (due) takeHeardFromDue(due);
  });

  async function signUpThrough(request: Parameters<typeof requestAuthDialog>[0]) {
    const user = { id: "u-new", email: "new@example.com", emailVerified: true } as AuthUser;
    spies.push(
      spyOn(apiClient, "signUp").mockResolvedValue(user),
      spyOn(apiClient, "getCurrentUser").mockReturnValue(user),
      spyOn(apiClient, "getSessionToken").mockReturnValue(null),
      spyOn(apiClient, "getSession").mockResolvedValue(user),
      spyOn(chatController, "refreshSession").mockResolvedValue(undefined as never),
    );
    await tui.render(<AuthDialogHost />, { width: 100, height: 40 });
    await act(async () => {
      expect(requestAuthDialog(request)).toBe(true);
    });
    await tui.waitForFrameToContain("Create your free Gloom Cloud account");
    for (const step of [
      () => tui.setup().mockInput.typeText("new@example.com"),
      () => tui.setup().mockInput.pressTab(),
      () => tui.setup().mockInput.typeText("correct horse battery"),
      () => tui.setup().mockInput.pressEnter(),
    ]) {
      await act(async () => {
        await step();
        await tui.setup().renderOnce();
      });
    }
    await tui.waitForFrameToExclude("Create your free Gloom Cloud account");
  }

  test("is due once the dialog closes on a new account", async () => {
    let continued = false;
    await signUpThrough({ mode: "signup", onSignedIn: () => { continued = true; } });
    expect(continued).toBe(true);
    expect(heardFromDueAccount()).toBe("u-new");
  });

  test("is never due when the sign-up goes on to a checkout", async () => {
    await signUpThrough({ mode: "signup", onSignedIn: () => {}, checkout: true });
    expect(heardFromDueAccount()).toBeNull();
  });
});
