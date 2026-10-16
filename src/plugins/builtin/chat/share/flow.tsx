import { pngDataUrl } from "../../../../shares/pane-image";
import { registerPaneChatSharing } from "../../../../shares/chat";
import type { GloomPluginContext } from "../../../../types/plugin";
import { MAX_CHAT_IMAGE_BYTES } from "../attachments/model";
import { chatController } from "../controller";

type ShareContext = Pick<GloomPluginContext, "createPaneFromTemplate">;

/** Chat's session and channel list, loaded when they are not yet. */
async function prepare(): Promise<void> {
  if (!chatController.getSnapshot().user?.emailVerified) await chatController.refreshSession().catch(() => {});
  if (chatController.getChannels().length === 0) await chatController.refreshChatState().catch(() => {});
}

/** Chat posts Report a Bug's picture; it adds no menu entry, command or key of its own. */
export function installPaneChatSharing(ctx: ShareContext): () => void {
  return registerPaneChatSharing({
    prepare,
    post: async (capture, channelId, content) => {
      if (capture.png.byteLength > MAX_CHAT_IMAGE_BYTES) {
        throw new Error("This pane's picture is over the 5 MB chat limit. Make the pane smaller and try again.");
      }
      const message = await chatController.postImage(channelId,
        { name: `${capture.paneType}.png`, type: "image/png", data: capture.png, previewUrl: pngDataUrl(capture.png) },
        content);
      return { messageId: message.id };
    },
    openMessage: (channelId, messageId) => {
      ctx.createPaneFromTemplate("new-chat-pane", { arg: channelId, values: { messageId } });
    },
  });
}
