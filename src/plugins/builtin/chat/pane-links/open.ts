import { PUBLIC_SHARE_ORIGIN } from "../../../../shares/api";
import { openShareLink } from "../../../../shares/open";
import type { AppNotificationRequest, PaneTemplateCreateOptions } from "../../../../types/plugin";
import { wirePaneTarget, type ChatMessagePaneLink } from "./model";
import { chatPaneLinkPane } from "./previews";

interface PaneLinkActions {
  createPaneFromTemplate(templateId: string, options?: PaneTemplateCreateOptions): void;
  notify(notification: AppNotificationRequest): unknown;
  openExternal(url: string): void;
  /** Runs text in the command bar as if typed there and entered. */
  runCommand(query: string): void;
}

/**
 * A share opens the way every share link does in this app; one it cannot open
 * here (offline, a snapshot) opens its web page instead. A Wire post opens its
 * story or calendar from the app's own pane templates. A function written in
 * a message runs in the command bar, so it opens where and as typing it would.
 */
export function openChatPaneLink(link: ChatMessagePaneLink, actions: PaneLinkActions): void {
  if (link.kind === "command") {
    actions.runCommand(link.query);
    return;
  }
  if (link.kind === "share") {
    openShareLink(link.id, () => actions.openExternal(new URL(`/s/${link.id}`, PUBLIC_SHARE_ORIGIN).toString()));
    return;
  }
  const target = wirePaneTarget(link.link);
  if (!chatPaneLinkPane(target.paneId)) {
    actions.notify({ body: "That pane is not available in this version of Gloom.", type: "info" });
    return;
  }
  actions.createPaneFromTemplate(target.templateId, target.arg ? { arg: target.arg } : undefined);
}
