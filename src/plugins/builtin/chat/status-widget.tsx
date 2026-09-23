import { Button } from "../../../components/ui/button";
import { Icon } from "../../../components/ui/icon";
import { useEffect, useState } from "react";
import { usePaneAppConfig } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import { Box, Span, Text, TextAttributes, useUiCapabilities } from "../../../ui";
import { usePluginAppActions } from "../../runtime";
import { InlineAuthActions } from "../cloud/auth-actions";
import {
  getPreferredChatOpenChannelId,
} from "./channels";
import { chatController, type ChatController } from "./controller";

interface ChatStatusWidgetProps {
  controller?: Pick<ChatController, "getSnapshot" | "refreshSession" | "subscribe">;
}

type ChatStatusSnapshot = ReturnType<ChatController["getSnapshot"]>;

function getTotalUnreadCount(snapshot: ChatStatusSnapshot) {
  return snapshot.channelStates.reduce((total, state) => total + Math.max(0, state.unreadCount), 0);
}

function CloudStatusIcon() {
  const { nativePaneChrome } = useUiCapabilities();
  if (!nativePaneChrome) {
    return <Text fg={colors.textDim}>☁ </Text>;
  }

  return (
    <Span
      fg={colors.textDim}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 14,
        height: 14,
        marginRight: 4,
        color: colors.textDim,
      }}
    >
      <Icon name="cloud" size={14} />
    </Span>
  );
}

export function ChatStatusWidget({ controller = chatController }: ChatStatusWidgetProps) {
  const { createPaneFromTemplate } = usePluginAppActions();
  const config = usePaneAppConfig();
  const cloudPluginDisabled = config.disabledPlugins.includes("gloomberb-cloud");
  const initialSnapshot = controller.getSnapshot();
  const [username, setUsername] = useState<string | null>(initialSnapshot.user?.username ?? null);
  const [hasSavedSession, setHasSavedSession] = useState(initialSnapshot.hasSavedSession);
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const unreadCount = getTotalUnreadCount(snapshot);

  const openChat = (event?: { preventDefault?: () => void; stopPropagation?: () => void }) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const channelId = getPreferredChatOpenChannelId(config, snapshot);
    createPaneFromTemplate("new-chat-pane", { arg: channelId });
  };

  useEffect(() => {
    const unsubscribe = controller.subscribe((nextSnapshot) => {
      setSnapshot(nextSnapshot);
      setUsername(nextSnapshot.user?.username ?? null);
      setHasSavedSession(nextSnapshot.hasSavedSession);
    });
    void controller.refreshSession().catch(() => {});
    return unsubscribe;
  }, [controller]);

  if (cloudPluginDisabled) return null;

  return (
    <Box flexDirection="row" paddingRight={1}>
      {!username && !hasSavedSession ? (
        <>
          <CloudStatusIcon />
          <InlineAuthActions showSignup={false} />
        </>
      ) : (
        <Button label={username ? `Open chat as ${username}` : "Open chat"} variant="plain" compact stopPropagation onPress={openChat}>
          <Text fg={unreadCount > 0 ? colors.text : colors.textDim}>
            <Span fg={colors.positive}>@</Span>
            {username ? (
              <>
                {" "}
                <Span fg={colors.positive}>{username}</Span>
              </>
            ) : null}
          </Text>
          {unreadCount > 0 ? (
            <Text fg={colors.positive} attributes={TextAttributes.BOLD}>{` [${unreadCount}]`}</Text>
          ) : null}
        </Button>
      )}
    </Box>
  );
}
