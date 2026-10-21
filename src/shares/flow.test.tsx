import { expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness, TestDialogProvider, type TestKeyEvent } from "../renderers/opentui/test-utils";
import { useDialog, type DialogApi } from "../ui/dialog";
import { claimCaptureFlow } from "./capture-flow";
import { sharePaneLink } from "./flow";
import { restoreShareApiAfterEach, SHARE_ID, SHARE_LINK, shareFlowFixture } from "./test-harness";

restoreShareApiAfterEach();
const tui = createOpenTuiTestHarness({ width: 80, height: 24 });

test("Share copies the pane's link with no dialog, then says so", async () => {
  const f = shareFlowFixture();
  await sharePaneLink(f.host, "test:1");
  expect(f.questions).toEqual([]);
  expect(f.created).toEqual([f.payload]);
  expect(f.copied).toEqual([SHARE_LINK]);
  expect(f.toasts).toEqual([{ body: "Link copied", type: "success", paneId: "test:1" }]);
});

let dialog: DialogApi | null = null;
function DialogCapture() {
  dialog = useDialog();
  return null;
}

test("a pane of the person's own data asks once in the terminal: Enter, Esc and a held Enter make no link, y copies it", async () => {
  await tui.render(<TestDialogProvider><DialogCapture /></TestDialogProvider>);
  const f = shareFlowFixture({ personalData: "holdings" });
  f.host.promptDialog = (prompt) => dialog!.prompt(prompt);
  const answer = async (keys: TestKeyEvent[]) => {
    let share: Promise<void> = Promise.resolve();
    await act(async () => {
      share = sharePaneLink(f.host, "test:1");
      await Bun.sleep(0);
    });
    const frame = await tui.waitForFrameToContain("Copy a public link?");
    expect(frame).toContain("This shows your holdings.");
    expect(frame).toContain("Anyone with the link can open this pane");
    for (const key of keys) await tui.emitKeypress(key);
    await act(() => share);
    await tui.waitForFrameToExclude("Copy a public link?");
  };

  await answer([{ name: "return" }]);
  await answer([{ name: "escape" }]);
  // The Enter that chose Share in a menu, still held: marked as repeats, or fresh presses where the terminal cannot tell.
  await answer([{ name: "return", repeated: true }, { name: "return" }, { name: "return", repeated: true }]);
  expect(f.created).toEqual([]);
  expect(f.copied).toEqual([]);
  expect(f.toasts).toEqual([]);

  await answer([{ name: "y", sequence: "y" }]);
  expect(f.copied).toEqual([SHARE_LINK]);
  expect(f.toasts).toEqual([{ body: "Link copied", type: "success", paneId: "test:1" }]);
});

test("a link that cannot be made says why in the pane and copies nothing", async () => {
  const none = shareFlowFixture({ sharePayload: null, personalData: "holdings" });
  await sharePaneLink(none.host, "test:1");
  // No question about a link that will not exist.
  expect(none.questions).toEqual([]);
  expect(none.created).toEqual([]);
  expect(none.toasts).toEqual([{ body: "A public link is unavailable for this pane.", type: "error", paneId: "test:1" }]);

  // The browser and Bun word a dropped connection differently; the message says the same.
  for (const dropped of [new TypeError("Failed to fetch"), new Error("Unable to connect. Is the computer able to access the url?")]) {
    const offline = shareFlowFixture();
    offline.createShare = async () => { throw dropped; };
    await sharePaneLink(offline.host, "test:1");
    expect(offline.copied).toEqual([]);
    expect(offline.toasts).toEqual([{ body: "Couldn't reach Gloom Cloud. Check your connection and try again.", type: "error", paneId: "test:1" }]);
  }
  // Anything else is no reason to blame the connection.
  const broken = shareFlowFixture();
  broken.createShare = async () => { throw new TypeError("undefined is not an object (evaluating 'payload.data')"); };
  await sharePaneLink(broken.host, "test:1");
  expect(broken.toasts).toEqual([{ body: "Could not create share.", type: "error", paneId: "test:1" }]);

  const signedOut = shareFlowFixture({}, { signedIn: false });
  await sharePaneLink(signedOut.host, "test:1");
  expect(signedOut.reads).toBe(0);
  expect(signedOut.toasts).toHaveLength(1);
  // What the account lacks is the app's to say, not the pane's.
  expect(signedOut.toasts[0]).toMatchObject({ body: "Sign in to share.", type: "info", action: { label: "Sign in" } });
  expect(signedOut.toasts[0]!.paneId).toBeUndefined();
});

test("a copy the browser refuses after the link is made keeps the link in the pane, and its Copy link copies it", async () => {
  const f = shareFlowFixture();
  const refused = Object.assign(new Error("The request is not allowed by the user agent or the platform in the current context."), { name: "NotAllowedError" });
  f.copyText = async () => { throw refused; };
  await sharePaneLink(f.host, "test:1");
  expect(f.created).toHaveLength(1);
  expect(f.toasts).toEqual([{ body: "Link ready", type: "info", persistent: true, paneId: "test:1", action: { label: "Copy link", onClick: expect.any(Function) } }]);

  // Refused again: said once more, with the link still there.
  f.toasts[0]!.action!.onClick();
  await Bun.sleep(0);
  expect(f.toasts[1]).toMatchObject({ body: "Couldn't copy the link.", type: "error", persistent: true, action: { label: "Copy link" } });

  f.copyText = async (text) => { f.copied.push(text); };
  f.toasts[1]!.action!.onClick();
  await Bun.sleep(0);
  expect(f.copied).toEqual([SHARE_LINK]);
  expect(f.toasts[2]).toEqual({ body: "Link copied", type: "success", paneId: "test:1" });
  // One link: the button copies it, it does not make another.
  expect(f.created).toHaveLength(1);
});

test("a second Share waits for the first link, and for Report a Bug", async () => {
  const f = shareFlowFixture();
  const pending = Promise.withResolvers<{ id: string; expiresAt: string }>();
  f.createShare = () => pending.promise;
  const first = sharePaneLink(f.host, "test:1");
  await Bun.sleep(0);
  await sharePaneLink(f.host, "test:1");
  expect(f.reads).toBe(1);
  pending.resolve({ id: SHARE_ID, expiresAt: "2027-01-01T00:00:00Z" });
  await first;
  expect(f.copied).toEqual([SHARE_LINK]);

  const report = claimCaptureFlow()!;
  await sharePaneLink(f.host, "test:1");
  expect(f.reads).toBe(1);
  report();
});
