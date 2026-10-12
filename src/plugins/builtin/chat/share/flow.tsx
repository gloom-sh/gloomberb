import { apiClient } from "../../../../api-client";
import { getSharedRegistry } from "../../../../plugins/registry";
import { pngDataUrl, type PaneImageCapture } from "../../../../shares/pane-image";
import type { GloomPluginContext } from "../../../../types/plugin";
import type { PromptContext } from "../../../../ui/dialog";
import { requestAuthDialog } from "../../cloud/auth-dialog";
import { MAX_CHAT_IMAGE_BYTES } from "../attachments/model";
import { LAST_VISITED_CHAT_CHANNEL_KEY } from "../channels";
import { chatController } from "../controller";
import { buildChatConversations } from "../conversations";
import { SHARE_DIALOG_COLUMNS, ShareToChatDialog, type SharePost } from "./dialog";
import { defaultShareTarget, shareTargets } from "./targets";

type ShareContext = Pick<GloomPluginContext, "notify" | "createPaneFromTemplate" | "configState">;

/** Border, padding and title the terminal dialog draws around its content. */
const TERMINAL_DIALOG_CHROME = 6;
/** Terminal rows the dialog takes besides the preview. */
const TERMINAL_FORM_ROWS = 20;

let sharing = false;

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Whether the account can post, saying in one line what is missing when it
 * cannot: a sign-in (which then carries on with the share) or a verified email.
 */
function readyToPost(ctx: ShareContext, retry: () => void): boolean {
  if (!apiClient.isSignedIn()) {
    ctx.notify({
      body: "Sign in to share to chat.",
      type: "info",
      action: { label: "Sign in", onClick: () => { requestAuthDialog({ onSignedIn: retry }); } },
    });
    return false;
  }
  if (!apiClient.isVerified()) {
    ctx.notify({
      body: "Verify your email to share to chat.",
      type: "info",
      action: {
        label: "Resend link",
        onClick: () => {
          void apiClient.sendVerification()
            .then(() => ctx.notify({ body: "Verification link sent.", type: "success" }))
            .catch((error) => ctx.notify({ body: errorText(error, "Couldn't send the email. Try again."), type: "error" }));
        },
      },
    });
    return false;
  }
  return true;
}

/** The conversations the account can post to, with chat's session and channel list loaded. */
async function loadTargets() {
  if (!chatController.getSnapshot().user?.emailVerified) await chatController.refreshSession().catch(() => {});
  if (chatController.getChannels().length === 0) await chatController.refreshChatState().catch(() => {});
  const list = chatController.listConversations();
  return shareTargets(list ? buildChatConversations(list.states, list.userId) : []);
}

/**
 * Share to Chat: takes a picture of a pane (the focused one when `paneId` is
 * left out) as it looks now, then lets the person pick a conversation, add a
 * caption and post it as their own message with the picture attached.
 */
export async function sharePaneToChat(ctx: ShareContext, paneId?: string): Promise<void> {
  if (sharing) return;
  const registry = getSharedRegistry();
  if (!registry) return;
  if (!readyToPost(ctx, () => { void sharePaneToChat(ctx, paneId); })) return;
  sharing = true;
  try {
    let capture: PaneImageCapture;
    try {
      capture = await registry.capturePaneImage(paneId);
    } catch (error) {
      ctx.notify({ body: errorText(error, "Couldn't take a picture of this pane."), type: "error" });
      return;
    }
    if (capture.png.byteLength > MAX_CHAT_IMAGE_BYTES) {
      ctx.notify({ body: "This pane's picture is over the 5 MB chat limit. Make the pane smaller and try again.", type: "error" });
      return;
    }

    const targets = await loadTargets();
    const defaultChannelId = defaultShareTarget(targets, ctx.configState.get<string>(LAST_VISITED_CHAT_CHANNEL_KEY));
    const viewport = registry.getTermSize();
    const width = Math.max(30, Math.min(SHARE_DIALOG_COLUMNS, viewport.width - TERMINAL_DIALOG_CHROME - 4));
    // The pane's own rows when it fits the dialog, else a thumbnail as tall as its shape.
    const naturalRows = capture.cells && capture.cells.cols <= width
      ? capture.cells.rows
      : Math.ceil((width * capture.height) / Math.max(1, capture.width) / 2);
    const previewRows = Math.max(4, Math.min(naturalRows, viewport.height - TERMINAL_FORM_ROWS));
    const previewUrl = pngDataUrl(capture.png);

    const post = async ({ channelId, caption }: SharePost) => {
      const message = await chatController.postImage(
        channelId,
        { name: `${capture.paneType}.png`, type: "image/png", data: capture.png, previewUrl },
        caption,
      );
      return { messageId: message.id };
    };

    const result = await registry.promptDialog<SharePost & { messageId: string }>({
      closeOnClickOutside: false,
      style: { width: width + TERMINAL_DIALOG_CHROME },
      content: (context: PromptContext<SharePost & { messageId: string }>) => (
        <ShareToChatDialog
          {...context}
          capture={capture}
          targets={targets}
          defaultChannelId={defaultChannelId}
          width={width}
          previewRows={previewRows}
          post={post}
        />
      ),
    });
    if (!result) return;
    void ctx.configState.set(LAST_VISITED_CHAT_CHANNEL_KEY, result.channelId).catch(() => {});
    const label = targets.find((target) => target.channelId === result.channelId)?.label ?? result.channelId;
    ctx.notify({
      body: `Posted to ${label}`,
      type: "success",
      action: {
        label: "Open",
        onClick: () => {
          ctx.createPaneFromTemplate("new-chat-pane", { arg: result.channelId, values: { messageId: result.messageId } });
        },
      },
    });
  } finally {
    sharing = false;
  }
}
