import { afterEach, expect, test } from "bun:test";
import { apiClient } from "../../../../api-client";
import type { PluginRegistry } from "../../../registry";
import type { BugReportDialogProps } from "../../../../shares/bug-report-dialog";
import { reportPaneBug } from "../../../../shares/bug-report-flow";
import { shareFocusedPane } from "../../../../shares/flow";
import type { PaneImageCapture } from "../../../../shares/pane-image";
import type { AppNotificationRequest, GloomPluginContext } from "../../../../types/plugin";
import { VERSION } from "../../../../version";
import { chatController } from "../controller";
import { installPaneChatSharing } from "./flow";

const original = {
  signedIn: apiClient.isSignedIn, verified: apiClient.isVerified,
  channels: chatController.getChannels, snapshot: chatController.getSnapshot,
  conversations: chatController.listConversations, post: chatController.postImage,
};
let disposeChat: (() => void) | undefined;
afterEach(() => {
  apiClient.isSignedIn = original.signedIn;
  apiClient.isVerified = original.verified;
  chatController.getChannels = original.channels;
  chatController.getSnapshot = original.snapshot;
  chatController.listConversations = original.conversations;
  chatController.postImage = original.post;
  disposeChat?.();
});

function fixture({ signedIn = true } = {}) {
  const capture: PaneImageCapture = { paneId: "chart:1", paneType: "chart", title: "AAPL", capturedAt: "2026-10-15T00:00:00Z",
    png: new Uint8Array([1, 2, 3, 4]), width: 4, height: 4, personalData: null };
  const posts: Array<{ channelId: string; image: { name: string; type: string; data: Uint8Array }; text: string }> = [];
  const toasts: AppNotificationRequest[] = [];
  const opened: Array<{ templateId: string; options: unknown }> = [];
  let captures = 0;
  let dialog = Promise.withResolvers<BugReportDialogProps>();
  apiClient.isSignedIn = () => signedIn;
  apiClient.isVerified = () => true;
  chatController.getChannels = () => [{ id: "bugs", name: "bugs", created_at: "2026-01-01" }];
  chatController.getSnapshot = () => ({ user: { emailVerified: true } }) as any;
  chatController.listConversations = () => null;
  chatController.postImage = async (channelId, image, text) => {
    posts.push({ channelId, image: { name: image.name, type: image.type, data: image.data as Uint8Array }, text });
    return { id: "invented-message" } as any;
  };
  const registry = {
    paneTemplates: new Map([["chart", { id: "chart", paneId: "chart", shortcut: { prefix: "GP" } }]]),
    capturePaneImage: async () => { captures += 1; return capture; },
    notify: (toast: AppNotificationRequest) => { toasts.push(toast); },
    getTermSize: () => ({ width: 140, height: 50 }),
    promptDialog: (options: any) => new Promise((resolve) => {
      dialog.resolve(options.content({ dialogId: "bug-report", resolve, dismiss: () => resolve(undefined) }).props);
    }),
  } as unknown as PluginRegistry;
  const ctx = {
    notify: (toast: AppNotificationRequest) => { toasts.push(toast); },
    createPaneFromTemplate: (templateId: string, options: unknown) => { opened.push({ templateId, options }); },
    configState: { get: () => undefined, set: async () => {} },
  } as unknown as GloomPluginContext;
  disposeChat = installPaneChatSharing(ctx);
  return {
    registry, capture, posts, toasts, opened,
    get captures() { return captures; },
    /** Opens the form and hands back its props once it is on screen, with the flow still running. */
    open: async () => {
      dialog = Promise.withResolvers<BugReportDialogProps>();
      const flow = reportPaneBug(registry, "chart:1");
      return { flow, props: await dialog.promise };
    },
  };
}

test("signed out, the sign-in prompt shows instead of the form, and nothing is pictured", async () => {
  const f = fixture({ signedIn: false });
  await reportPaneBug(f.registry, "chart:1");
  expect(f.captures).toBe(0);
  expect(f.toasts).toHaveLength(1);
  expect(f.toasts[0]).toMatchObject({ body: "Sign in to report a bug.", type: "info", action: { label: "Sign in" } });
  expect(f.posts).toEqual([]);
});

test("Send posts one message to #bugs: the line, the pane, the app version and the picture", async () => {
  const f = fixture();
  const { flow, props } = await f.open();
  expect(props.context).toBe(`GP AAPL · v${VERSION} · terminal`);
  // A second report waits for this one, and so does Share: one picture and one dialog at a time.
  await reportPaneBug(f.registry, "chart:1");
  await shareFocusedPane(f.registry, "chart:1");
  expect(f.captures).toBe(1);

  props.resolve(await props.send("Chart stops updating after 1D"));
  await flow;
  expect(f.posts).toEqual([{
    channelId: "bugs",
    image: { name: "chart.png", type: "image/png", data: f.capture.png },
    text: `Chart stops updating after 1D\n\nPane: GP AAPL · v${VERSION} · terminal`,
  }]);
  const toast = f.toasts.at(-1)!;
  expect(toast).toMatchObject({ body: "Bug report posted to #bugs", type: "success", action: { label: "Open" } });
  toast.action!.onClick();
  expect(f.opened).toEqual([{ templateId: "new-chat-pane", options: { arg: "bugs", values: { messageId: "invented-message" } } }]);
});

test("a long pane title is cut once: the form shows the pane line the message posts", async () => {
  const f = fixture();
  f.capture.title = `AAPL ${"Apple Inc. common stock ".repeat(4)}`.trim();
  const { flow, props } = await f.open();
  expect(props.context).toBe(`GP ${f.capture.title.slice(0, 54)}... · v${VERSION} · terminal`);
  props.resolve(await props.send("Title runs off the header"));
  await flow;
  expect(f.posts[0]!.text).toBe(`Title runs off the header\n\nPane: ${props.context}`);
});

test("a closed form keeps what was typed for the next report; a sent one clears it", async () => {
  const f = fixture();
  const first = await f.open();
  first.props.onTextChange?.("Half a sentence");
  first.props.dismiss();
  await first.flow;
  const second = await f.open();
  expect(second.props.initialText).toBe("Half a sentence");
  second.props.resolve(await second.props.send("Half a sentence, finished"));
  await second.flow;
  const third = await f.open();
  expect(third.props.initialText).toBe("");
  third.props.dismiss();
  await third.flow;
});
