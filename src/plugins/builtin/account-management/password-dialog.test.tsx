import { act } from "react";
import { expect, test } from "bun:test";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { DeleteAccountPasswordDialog, PasswordChangeDialog } from "./password-dialog";

const tui = createOpenTuiTestHarness();

async function type(text: string) {
  await act(async () => {
    tui.setup().mockInput.typeText(text);
    await tui.setup().renderOnce();
  });
}
async function enter() {
  await tui.emitKeypress({ name: "return", sequence: "\r" });
  await act(async () => { await tui.setup().renderOnce(); });
}

async function fill(confirm: string) {
  const calls: Array<[string, string]> = [];
  await tui.render(
    <PasswordChangeDialog dismiss={() => {}} onChangePassword={async (current, next) => { calls.push([current, next]); }} />,
    { width: 80, height: 24 },
  );
  await tui.renderFrames(2);
  await type("old-password");
  await enter();
  await type("new-password1");
  await enter();
  await type(confirm);
  await enter();
  await tui.renderFrames(2);
  return calls;
}

// The confirm field submits on Enter itself; a second Enter binding on the
// dialog sent the change twice.
test("Enter on the confirm field changes the password once", async () => {
  expect(await fill("new-password1")).toEqual([["old-password", "new-password1"]]);
});

test("Enter on a confirm that differs from the new password changes nothing", async () => {
  expect(await fill("other-password")).toEqual([]);
  await tui.waitForFrameToContain("New passwords do not match");
});

async function deleteWith(password: string, answer: () => Promise<void>) {
  const calls: string[] = [];
  let dismissed = 0;
  await tui.render(
    <DeleteAccountPasswordDialog
      dismiss={() => { dismissed += 1; }}
      onDelete={async (value) => { calls.push(value); await answer(); }}
    />,
    { width: 80, height: 24 },
  );
  await tui.renderFrames(2);
  await tui.waitForFrameToContain("Enter your password to delete");
  if (password) await type(password);
  await enter();
  await tui.renderFrames(2);
  return { calls, dismissed: () => dismissed };
}

test("Enter on the password deletes the account once, then closes", async () => {
  const result = await deleteWith("the-password", async () => {});
  expect(result.calls).toEqual(["the-password"]);
  expect(result.dismissed()).toBe(1);
});

test("a wrong password keeps the dialog open with the server's answer", async () => {
  const result = await deleteWith("a-guess", async () => {
    throw new Error("That password is not right.");
  });
  expect(result.calls).toEqual(["a-guess"]);
  await tui.waitForFrameToContain("That password is not right.");
  expect(result.dismissed()).toBe(0);
});

test("an empty password sends nothing", async () => {
  const result = await deleteWith("", async () => {});
  expect(result.calls).toEqual([]);
  await tui.waitForFrameToContain("Enter your password.");
  expect(result.dismissed()).toBe(0);
});
