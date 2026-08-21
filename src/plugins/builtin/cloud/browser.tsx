import { ChatContent } from "../chat/content";
import { createChatPane } from "../chat/pane";
import { ChatStatusWidget } from "../chat/status-widget";
import { createGloomberbCloudPlugin } from "./plugin";

export const browserGloomberbCloudPlugin = createGloomberbCloudPlugin({
  ChatPane: createChatPane(ChatContent),
  ChatStatusWidget,
});
