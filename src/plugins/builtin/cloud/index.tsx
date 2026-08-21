import { ChatContent } from "../chat/content";
import { buildoutModule } from "./buildout-module";
import { createChatPane } from "../chat/pane";
import { ChatStatusWidget } from "../chat/status-widget";
import { createGloomberbCloudPlugin } from "./plugin";

const ChatPane = createChatPane(ChatContent);

export const gloomberbCloudPlugin = createGloomberbCloudPlugin({
  ChatPane,
  ChatStatusWidget,
  extraModules: [buildoutModule],
});
