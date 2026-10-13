import { apiClient } from "../../../../api-client";
import { pngDataUrl } from "../../../../shares/pane-image";
import { registerPaneChatSharing } from "../../../../shares/chat";
import type { GloomPluginContext } from "../../../../types/plugin";
import { requestAuthDialog } from "../../../../account/auth-dialog";
import { MAX_CHAT_IMAGE_BYTES } from "../attachments/model";
import { LAST_VISITED_CHAT_CHANNEL_KEY } from "../channels";
import { chatController } from "../controller";
import { buildChatConversations } from "../conversations";
import { defaultShareTarget, shareTargets } from "./targets";

type ShareContext = Pick<GloomPluginContext, "notify" | "createPaneFromTemplate" | "configState">;
const INCLUDE_LINK_KEY = "share.includeLink";

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

/** Chat contributes a destination, never another menu entry, command or key. */
export function installPaneChatSharing(ctx: ShareContext): () => void {
  return registerPaneChatSharing({
    ready: (retry) => readyToPost(ctx, retry),
    targets: loadTargets,
    defaultChannel: (targets) => defaultShareTarget(targets, ctx.configState.get<string>(LAST_VISITED_CHAT_CHANNEL_KEY)),
    includeLink: () => ctx.configState.get<boolean>(INCLUDE_LINK_KEY) !== false,
    setIncludeLink: (value) => { void ctx.configState.set(INCLUDE_LINK_KEY, value).catch(() => {}); },
    post: async (capture, { channelId }, content) => {
      if (capture.png.byteLength > MAX_CHAT_IMAGE_BYTES) {
        throw new Error("This pane's picture is over the 5 MB chat limit. Make the pane smaller and try again.");
      }
      const message = await chatController.postImage(channelId,
        { name: `${capture.paneType}.png`, type: "image/png", data: capture.png, previewUrl: pngDataUrl(capture.png) },
        content);
      return { messageId: message.id };
    },
    posted: (result, targets) => {
      void ctx.configState.set(LAST_VISITED_CHAT_CHANNEL_KEY, result.channelId).catch(() => {});
      const label = targets.find(target => target.channelId === result.channelId)?.label ?? result.channelId;
      ctx.notify({
        body: `Posted to ${label}`,
        type: "success",
        action: { label: "Open", onClick: () => {
          ctx.createPaneFromTemplate("new-chat-pane", { arg: result.channelId, values: { messageId: result.messageId } });
        } },
      });
    },
  });
}
