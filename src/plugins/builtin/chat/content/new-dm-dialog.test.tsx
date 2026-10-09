import { describe, expect, test } from "bun:test";
import { act } from "react";
import type { ChatChannel, ChatUserSummary } from "../../../../api-client";
import { createOpenTuiTestHarness } from "../../../../renderers/opentui/test-utils";
import { NewDmDialog } from "./new-dm-dialog";

const tui = createOpenTuiTestHarness({ width: 64, height: 20 });

const users: ChatUserSummary[] = [
  { id: "u-birch", username: "birch", displayName: "Birch", acceptUnknownDms: false },
  { id: "u-cedar", username: "cedar", displayName: "Cedar", acceptUnknownDms: false },
  { id: "u-maple", username: "maple", displayName: "Maple", acceptUnknownDms: true },
];
const dmWithCedar: ChatChannel = {
  id: "dm:cedar",
  name: "@cedar",
  kind: "direct",
  created_at: "2026-07-03T09:30:00.000Z",
  dmUser: users[1],
};

async function renderDialog() {
  const submitted: string[][] = [];
  const opened: string[] = [];
  await act(async () => {
    await tui.render(
      <NewDmDialog
        width={64}
        height={20}
        userByUsername={new Map(users.map((user) => [user.username!, user]))}
        currentUserId="u-self"
        channels={[dmWithCedar]}
        onCancel={() => {}}
        onOpenChannel={(channelId) => { opened.push(channelId); }}
        onSubmit={async (usernames) => { submitted.push(usernames); }}
      />,
    );
  });
  await tui.renderFrames(2);
  return { submitted, opened };
}

async function type(text: string) {
  await act(async () => {
    await tui.setup().mockInput.typeText(text);
    await tui.setup().renderOnce();
  });
}

async function press(name: "tab" | "return") {
  await tui.emitKeypress({ name, sequence: name === "tab" ? "\t" : "\r" });
  await tui.renderFrames(2);
}

describe("NewDmDialog", () => {
  test("a user who takes no DMs from you is listed but cannot be picked", async () => {
    const { submitted } = await renderDialog();
    const birchRow = tui.frame().split("\n").find((line) => line.includes("@birch")) ?? "";
    expect(birchRow).toContain("no DMs");
    // The cursor starts past @birch, on the first user who can be picked.
    await press("tab");
    expect(tui.frame()).toContain("@cedar ");

    // Tab again takes @cedar back out, leaving the field empty.
    await press("tab");
    await type("@birch");
    expect(await tui.waitForFrameToContain("@birch only takes DMs")).toBeTruthy();
    await press("return");
    expect(submitted).toEqual([]);
  });

  test("a DM you already share opens without starting a new one", async () => {
    const { submitted, opened } = await renderDialog();
    await type("@cedar");
    await press("return");
    expect(opened).toEqual(["dm:cedar"]);
    expect(submitted).toEqual([]);
  });
});
