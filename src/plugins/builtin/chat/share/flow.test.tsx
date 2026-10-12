import { afterEach, expect, test } from "bun:test";
import { apiClient } from "../../../../api-client";
import { type PluginRegistry } from "../../../registry";
import { buildPaneSharePayload } from "../../../../shares/pane";
import type { PaneImageCapture } from "../../../../shares/pane-image";
import type { GloomPluginContext } from "../../../../types/plugin";
import { chatController } from "../controller";
import type { ShareDialogProps } from "../../../../shares/dialog";
import { shareFocusedPane } from "../../../../shares/flow";
import { installPaneChatSharing } from "./flow";

let disposeChat: (() => void) | undefined;

const original = {
  signedIn: apiClient.isSignedIn, verified: apiClient.isVerified,
  create: apiClient.createTerminalShare,
  channels: chatController.getChannels, snapshot: chatController.getSnapshot,
  conversations: chatController.listConversations, post: chatController.postImage,
};
afterEach(() => {
  apiClient.isSignedIn = original.signedIn;
  apiClient.isVerified = original.verified;
  apiClient.createTerminalShare = original.create;
  chatController.getChannels = original.channels;
  chatController.getSnapshot = original.snapshot;
  chatController.listConversations = original.conversations;
  chatController.postImage = original.post;
  disposeChat?.();
});

function fixture() {
  const payload = buildPaneSharePayload({ panes: new Map([["test", { id: "test", name: "Test" }]]), paneTemplates: new Map() } as any,
    { paneId: "test", instanceId: "test:1", settings: { selectedTab: "options", expiry: "2027-01-15" } });
  const capture: PaneImageCapture = { paneId: "test:1", paneType: "test", title: "Test", capturedAt: "2026-10-12T00:00:00Z",
    png: new Uint8Array(4), width: 4, height: 4, personalData: "holdings", sharePayload: payload };
  const config = new Map<string, unknown>();
  let dialog: ShareDialogProps;
  let created = 0;
  let fail = false;
  const sent: string[] = [];
  apiClient.isSignedIn = () => true;
  apiClient.isVerified = () => true;
  apiClient.createTerminalShare = async (value) => {
    expect(value).toEqual(payload);
    created++;
    if (fail) throw new Error("Link unavailable");
    return { id: "a".repeat(32), expiresAt: "2027-01-01T00:00:00Z" };
  };
  chatController.getChannels = () => [{ id: "everyone", name: "everyone", created_at: "2026-01-01" }];
  chatController.getSnapshot = () => ({ user: { emailVerified: true } }) as any;
  chatController.listConversations = () => null;
  chatController.postImage = async (_channel, _image, text) => { sent.push(text); return { id: "m1" } as any; };
  const registry = {
    capturePaneImage: async () => capture,
    notify: () => {},
    getTermSize: () => ({ width: 140, height: 50 }),
    promptDialog: async (options: any) => { dialog = options.content({}).props; },
  } as unknown as PluginRegistry;
  const ctx = { notify: () => {}, createPaneFromTemplate: () => {}, configState: {
    get: (key: string) => config.get(key), set: async (key: string, value: unknown) => { config.set(key, value); },
  } } as unknown as GloomPluginContext;
  disposeChat = installPaneChatSharing(ctx);
  return { capture, sent, get created() { return created; }, set fail(value: boolean) { fail = value; },
    open: async () => { await shareFocusedPane(registry); return dialog!; } };
}

test("cancel creates no link; copy and post reuse the captured view; the include choice survives reopening", async () => {
  const f = fixture();
  const dialog = await f.open();
  expect(f.created).toBe(0);
  expect(dialog.capture.personalData).toBe("holdings");
  expect(dialog.defaultIncludeLink).toBe(true);
  const url = await dialog.getLink!();
  await dialog.post({ channelId: "everyone", caption: "  Look at this expiry  ", includeLink: true });
  expect(f.sent).toEqual([`Look at this expiry\n\n${url}`]);
  expect(f.created).toBe(1);
  dialog.onIncludeLinkChange(false);
  const reopened = await f.open();
  expect(reopened.defaultIncludeLink).toBe(false);
  await reopened.post({ channelId: "everyone", caption: "", includeLink: false });
  expect(f.sent.at(-1)).toBe("");
  expect(f.created).toBe(1);
});

test("a gated/unshareable pane posts only the picture", async () => {
  const f = fixture();
  f.capture.sharePayload = null;
  const pictureOnly = await f.open();
  expect(pictureOnly.getLink).toBeNull();
  await pictureOnly.post({ channelId: "everyone", caption: "", includeLink: true });
  expect(f.sent).toEqual([""]);
  expect(f.created).toBe(0);
});

test("disabling chat keeps Copy link available through the same dialog", async () => {
  const f = fixture();
  disposeChat?.();
  const dialog = await f.open();
  expect(dialog.chatAvailable).toBe(false);
  expect(dialog.targets).toEqual([]);
  expect(await dialog.getLink!()).toContain("/api/shares/");
  expect(f.sent).toEqual([]);
});

test("link creation failure is retryable and happens before uploading or sending the picture", async () => {
  const f = fixture();
  const dialog = await f.open();
  f.fail = true;
  const request = { channelId: "everyone", caption: "", includeLink: true };
  await expect(dialog.post(request)).rejects.toThrow("Link unavailable");
  expect(f.sent).toEqual([]);
  f.fail = false;
  await dialog.post(request);
  expect(f.created).toBe(2);
  expect(f.sent[0]).toContain("/api/shares/");
});
