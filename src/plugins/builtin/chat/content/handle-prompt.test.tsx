import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { apiClient, type AccountProfile, type AccountProfileUpdate, type AuthUser, type ChatMessage } from "../../../../api-client";
import { ApiRequestError } from "../../../../api-client/errors";
import type { AppNotificationRequest } from "../../../../types/plugin";
import { createTestPluginRuntime } from "../../../../test-support/plugin-runtime";
import { displayWidth } from "../../../../utils/format";
import { chatHandlePromptStore, handleProfileUpdate, isPlaceholderUsername } from "../handle-prompt";
import {
  createChatTestHarness,
  createController,
  makeAccountProfile,
  makeMessage,
  MemoryPersistence,
} from "../test-harness";

const tui = createChatTestHarness();
const { emitKeypress, flushFrame, mountChat } = tui;

const PLACEHOLDER = "gloom_3fa91c0d5e7b2a48";
const OTHER_PLACEHOLDER = "gloom_0123456789abcdef";
const PROMPT = "Choose a handle";

const originalGetCurrentUser = apiClient.getCurrentUser.bind(apiClient);
const originalGetAccountProfile = apiClient.getAccountProfile.bind(apiClient);
const originalUpdateAccountProfile = apiClient.updateAccountProfile.bind(apiClient);

afterEach(() => {
  apiClient.getCurrentUser = originalGetCurrentUser;
  apiClient.getAccountProfile = originalGetAccountProfile;
  apiClient.updateAccountProfile = originalUpdateAccountProfile;
});

/**
 * The account the API client holds, as the prompt checks it around each
 * request. Set after the chat controller is made, which reads its session first.
 */
function signInAs(id: string) {
  apiClient.getCurrentUser = () => ({ id } as AuthUser);
}

function placeholderAccount(id = "u0", username = PLACEHOLDER): AccountProfile {
  return makeAccountProfile({ id, username, name: username });
}

function fakeProfileApi(account: AccountProfile) {
  const updates: AccountProfileUpdate[] = [];
  apiClient.getAccountProfile = async () => account;
  apiClient.updateAccountProfile = async (update) => {
    updates.push(update);
    return { ...account, ...update } as AccountProfile;
  };
  return updates;
}

function placeholderController(options: { id?: string; username?: string; messages?: ChatMessage[] } = {}) {
  const controller = createController({
    messages: options.messages ?? [makeMessage(1)],
    user: { id: options.id ?? "u0", username: options.username ?? PLACEHOLDER, emailVerified: true },
  });
  // Every chat view refreshes the session as it mounts; count only the ones after.
  let refreshes = 0;
  let mounted = 0;
  controller.refreshSession = async () => {
    refreshes += 1;
  };
  return {
    controller,
    mounted: () => { mounted = refreshes; },
    refreshes: () => refreshes - mounted,
  };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await flushFrame();
}

async function press(name: string, sequence = name) {
  await emitKeypress({ name, sequence });
  await flushFrame();
}

async function type(text: string) {
  await act(async () => {
    await tui.setup().mockInput.typeText(text);
  });
  await flushFrame();
}

/** Clicks a cell of the first line showing `text`, counting the sidebar's wide channel names as two cells. */
async function clickText(text: string, offset = 0) {
  const rows = tui.frame().split("\n");
  const row = rows.findIndex((line) => line.includes(text));
  if (row < 0) throw new Error(`No frame text "${text}".\n${tui.frame()}`);
  const line = rows[row]!;
  await act(async () => {
    await tui.setup().mockMouse.click(displayWidth(line.slice(0, line.indexOf(text))) + offset, row);
  });
  await flushFrame();
}

/** Types a draft into the composer, then leaves it with Esc. */
async function writeDraftAndLeave(draft: string) {
  await clickText("Type a message...", 1);
  await type(draft);
  await press("escape", "\u001b");
}

/** Clicks into the empty handle field (the pane shell binds its `@` key), types and presses Enter. */
async function chooseHandle(handle: string) {
  await clickText("@handle", 1);
  await type(handle);
  await act(async () => {
    tui.setup().mockInput.pressEnter();
  });
  await settle();
}

describe("which accounts are asked", () => {
  test("only the exact signup placeholder counts as unchosen", () => {
    expect(isPlaceholderUsername(PLACEHOLDER)).toBe(true);
    for (const username of [
      "gloom_3FA91C0D5E7B2A48",
      "gloom_3fa91c0d5e7b2a4",
      "gloom_3fa91c0d5e7b2a481",
      "gloom_3fa91c0d5e7b2a4g",
      "xgloom_3fa91c0d5e7b2a48",
      "gloom_trader",
      "ada",
      "",
      null,
      undefined,
    ]) {
      expect(isPlaceholderUsername(username)).toBe(false);
    }
  });

  test("a name from signup's placeholder goes with the handle; a real one stays", () => {
    expect(handleProfileUpdate({ username: PLACEHOLDER, name: PLACEHOLDER }, "vince")).toEqual({ username: "vince", name: "vince" });
    expect(handleProfileUpdate({ username: PLACEHOLDER, name: "Ada Lovelace" }, "vince")).toEqual({ username: "vince" });
  });

  test("a verified person on the placeholder sees it; a chosen name, a bot, an unverified or signed-out account does not", async () => {
    const cases: Array<{ name: string; user: { id: string; username: string; emailVerified: boolean } | null; messages?: ChatMessage[]; shown: boolean }> = [
      { name: "placeholder", user: { id: "u0", username: PLACEHOLDER, emailVerified: true }, shown: true },
      { name: "chosen", user: { id: "u0", username: "ada", emailVerified: true }, shown: false },
      { name: "unverified", user: { id: "u0", username: PLACEHOLDER, emailVerified: false }, shown: false },
      { name: "signed out", user: null, shown: false },
      {
        name: "bot",
        user: { id: "u0", username: PLACEHOLDER, emailVerified: true },
        messages: [{ ...makeMessage(1), user: { id: "u0", username: PLACEHOLDER, displayName: "Desk", accountType: "managed_llm" } }],
        shown: false,
      },
    ];
    for (const entry of cases) {
      const controller = createController({ messages: entry.messages ?? [makeMessage(1)], user: entry.user });
      await mountChat(controller, { width: 72, height: 12 });
      expect({ name: entry.name, shown: tui.frame().includes(PROMPT) }).toEqual({ name: entry.name, shown: entry.shown });
    }
  });
});

describe("choosing a handle", () => {
  test("saves it, keeps the channel and the draft, and hands the keyboard to the composer", async () => {
    const updates = fakeProfileApi(placeholderAccount());
    const notices: AppNotificationRequest[] = [];
    const { controller, mounted, refreshes } = placeholderController();
    signInAs("u0");
    await mountChat(controller, {
      width: 72,
      height: 14,
      withFooter: true,
      runtime: createTestPluginRuntime({ notify: (notice) => { notices.push(notice); } }),
    });
    mounted();
    expect(tui.frame()).toContain("[@] handle");

    await writeDraftAndLeave("hello there");
    await chooseHandle("@Vince_1 ");

    expect(updates).toEqual([{ username: "Vince_1", name: "Vince_1" }]);
    expect(tui.frame()).not.toContain(PROMPT);
    expect(refreshes()).toBe(1);
    expect(notices.map((notice) => notice.type)).toEqual(["success"]);
    expect(controller.getSnapshot("everyone").draft).toBe("hello there");

    // The composer has the keyboard again, with the draft where it was.
    await type("!");
    expect(controller.getSnapshot("everyone").draft).toBe("hello there!");
  });

  test("a taken handle stays in the field with the reason until it is changed", async () => {
    fakeProfileApi(placeholderAccount());
    apiClient.updateAccountProfile = async () => {
      throw new ApiRequestError("Username is already taken.", 409);
    };
    const { controller, mounted, refreshes } = placeholderController();
    signInAs("u0");
    await mountChat(controller, { width: 72, height: 14 });
    mounted();

    await chooseHandle("vince");
    expect(tui.frame()).toContain("@vince is taken. Try another.");
    expect(tui.frame()).toContain("@vince");
    expect(refreshes()).toBe(0);

    // Still in the field: the next key edits the handle and clears the reason.
    await type("2");
    expect(tui.frame()).not.toContain("is taken");
    expect(tui.frame()).toContain("@vince2");
    expect(controller.getSnapshot("everyone").draft).toBe("");
  });

  test("Not now is remembered for that account on this device, not for the next one", async () => {
    const persistence = new MemoryPersistence();
    chatHandlePromptStore.attach(persistence);
    const first = placeholderController();
    await mountChat(first.controller, { width: 72, height: 12 });
    await clickText("Not now", 1);
    expect(tui.frame()).not.toContain(PROMPT);

    // A restart reads it back.
    await act(async () => {
      chatHandlePromptStore.reset();
      chatHandlePromptStore.attach(persistence);
    });
    await mountChat(placeholderController().controller, { width: 72, height: 12 });
    expect(tui.frame()).not.toContain(PROMPT);

    await mountChat(placeholderController({ id: "u9", username: OTHER_PLACEHOLDER }).controller, { width: 72, height: 12 });
    expect(tui.frame()).toContain(PROMPT);
  });

  test("a save that finishes after another account signed in leaves that account alone", async () => {
    fakeProfileApi(placeholderAccount());
    const pending = Promise.withResolvers<AccountProfile>();
    const updates: AccountProfileUpdate[] = [];
    apiClient.updateAccountProfile = (update) => {
      updates.push(update);
      return pending.promise;
    };
    const notices: AppNotificationRequest[] = [];
    const { controller, mounted, refreshes } = placeholderController();
    signInAs("u0");
    await mountChat(controller, {
      width: 72,
      height: 14,
      withFooter: true,
      runtime: createTestPluginRuntime({ notify: (notice) => { notices.push(notice); } }),
    });
    mounted();
    await chooseHandle("vince");
    expect(updates).toEqual([{ username: "vince", name: "vince" }]);
    expect(tui.frame()).toContain("saving");

    await act(async () => {
      controller.adoptSession("other-token", { id: "u9", username: OTHER_PLACEHOLDER, emailVerified: true });
    });
    signInAs("u9");
    await flushFrame();
    // The next account starts on an empty prompt, not on the save still out.
    expect(tui.frame()).toContain("@handle");
    expect(tui.frame()).not.toContain("saving");
    pending.resolve({ ...placeholderAccount(), username: "vince", name: "vince" });
    await settle();

    const frame = tui.frame();
    expect(frame).toContain(PROMPT);
    expect(frame).not.toContain("saving");
    expect(frame).not.toContain("@vince");
    expect(notices).toEqual([]);
    expect(refreshes()).toBe(0);
  });
});
