import { act } from "react";
import { expect, test } from "bun:test";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { PasswordChangeDialog } from "./password-dialog";

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
