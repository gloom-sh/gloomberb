import { Button } from "../../../components/ui/button";
import { Badge, ClippedText } from "../../../components/ui/display";
import { Icon } from "../../../components/ui/icon";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  STATUS_WIDGET_COLUMNS,
  useOtherStatusWidgetClaims,
  useStatusWidgetClaim,
  useStatusWidgetRoom,
} from "../../../components/layout/status-widget-space";
import { usePaneAppConfig } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import { Box, Span, Text, useUiCapabilities } from "../../../ui";
import { clipToDisplayWidth, displayWidth } from "../../../utils/format";
import { usePluginAppActions } from "../../runtime";
import { getNotificationLog, subscribeNotificationLog } from "../../../notifications/notification-log";
import { InlineAuthActions } from "../cloud/auth-actions";
import {
  getPreferredChatOpenChannelId,
} from "./channels";
import { chatController, type ChatController } from "./controller";
import type { ChatStatusPreviewItem } from "./status-preview";
import { UNREAD_INBOX_TEMPLATE_ID } from "./unread-inbox";
import { unreadForYou, unreadTotal } from "./unread-badge";

interface ChatStatusWidgetProps {
  controller?: Pick<ChatController, "getSnapshot" | "refreshSession" | "subscribe" | "trackUnreadPeople" | "statusPreview">;
}

/** The widget's claim on the status bar's spare columns, for the chip and the message on arrival. */
const CLAIM_ID = "chat";
/** A name in the chip is cut to this many columns. */
const CHIP_NAME_COLUMNS = 12;
/** The message on arrival never takes more columns than this, and does not show in fewer than the least. */
const PREVIEW_MOST_COLUMNS = 48;
const PREVIEW_LEAST_COLUMNS = 12;

/** Who the chip names: the sender of the newest message for you, and whether it came in a DM or group chat. */
interface ChipWho {
  senderName: string;
  direct: boolean;
}

interface ChipFace {
  icon?: "mail";
  label: string;
  /** Terminal cells, its padding included. */
  columns: number;
}

/**
 * The chip: an envelope for a DM or group message, `@` for a mention or a
 * reply, then the sender's name and how many others want you, each left out
 * when `name` or `more` says so.
 */
function chipFace(who: ChipWho, others: number, { name, more }: { name: boolean; more: boolean }): ChipFace {
  const label = [
    who.direct ? "" : "@",
    name ? clipToDisplayWidth(who.senderName, CHIP_NAME_COLUMNS) : "",
    more && others > 0 ? `+${others}` : "",
  ].filter(Boolean).join(" ");
  // The glyph and its space (one cell wide in a terminal), then the label, inside one cell of padding each side.
  const columns = (who.direct ? (label ? 2 : 1) : 0) + displayWidth(label) + 2;
  return { ...(who.direct ? { icon: "mail" as const } : {}), label, columns };
}

/** The chip's faces from the fullest down: the name goes last, the count of others before it. */
const CHIP_FACES = [
  { name: true, more: true },
  { name: true, more: false },
  { name: false, more: true },
  { name: false, more: false },
];

/**
 * How the chip and the message fit in `spare` columns beside the account
 * name: the full chip and the message, then the chip alone, shorter and
 * shorter, or nothing. One space goes after the chip; the message takes one
 * before it and one more after, so it does not run into the account name.
 */
function fitChip(who: ChipWho | null, others: number, text: string | null, spare: number): { face: ChipFace; previewColumns: number } | null {
  if (!who) return null;
  for (const [index, parts] of CHIP_FACES.entries()) {
    const face = chipFace(who, others, parts);
    if (face.columns + 1 > spare) continue;
    const room = Math.min(PREVIEW_MOST_COLUMNS, spare - face.columns - 3);
    const previewColumns = text && index === 0 && room >= PREVIEW_LEAST_COLUMNS ? Math.min(room, displayWidth(text)) : 0;
    return { face, previewColumns };
  }
  return null;
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
  const { nativePaneChrome } = useUiCapabilities();
  const config = usePaneAppConfig();
  const initialSnapshot = controller.getSnapshot();
  const [username, setUsername] = useState<string | null>(initialSnapshot.user?.username ?? null);
  const [hasSavedSession, setHasSavedSession] = useState(initialSnapshot.hasSavedSession);
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  // What the Unread list shows as unread: chat, then missed price, catalyst, economic release and team notices.
  const notices = useSyncExternalStore(subscribeNotificationLog, getNotificationLog, getNotificationLog);
  const preview = useSyncExternalStore(controller.statusPreview.subscribe, controller.statusPreview.get, controller.statusPreview.get);
  const room = useStatusWidgetRoom();
  const othersClaimed = useOtherStatusWidgetClaims(CLAIM_ID);
  const signedIn = !!username || hasSavedSession;

  // Who wants you: the people the app badge counts, the newest of them named in the chip.
  const forYou = unreadForYou(snapshot);
  const total = unreadTotal(snapshot, notices);
  // A message on arrival shows until its conversation is read.
  const unreadIn = (channelId: string) => snapshot.channelStates.find((state) => state.channelId === channelId)?.unreadCount ?? 0;
  const arriving = preview && unreadIn(preview.channelId) > 0 ? preview : null;
  const who: ChipWho | null = arriving ?? forYou.latest;
  const others = Math.max(0, forYou.people - 1);
  // The status bar holds back its usual columns for every widget's own text; the chip and the message are extra.
  const spare = room - STATUS_WIDGET_COLUMNS - othersClaimed;
  const fit = signedIn ? fitChip(who, others, arriving?.text ?? null, spare) : null;
  // Chatter and missed notices: the rest, once the chip names who wants you.
  const rest = fit ? Math.max(0, total - forYou.messages) : total;
  const showsMessage = !!arriving && !!fit && fit.previewColumns > 0;
  useStatusWidgetClaim(CLAIM_ID, fit ? fit.face.columns + 1 + (showsMessage ? fit.previewColumns + 2 : 0) : 0);

  // The alerts ask, as a message arrives, whether the bar has room to show it; if not, its toast goes up.
  const fits = useRef<(item: ChatStatusPreviewItem) => boolean>(() => false);
  fits.current = (item) => (fitChip(item, others, item.text, spare)?.previewColumns ?? 0) > 0;
  useEffect(() => {
    if (!signedIn) return;
    return controller.statusPreview.attach((item) => fits.current(item));
  }, [controller, signedIn]);

  const openChat = (event?: { preventDefault?: () => void; stopPropagation?: () => void }) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const channelId = getPreferredChatOpenChannelId(config, snapshot);
    createPaneFromTemplate("new-chat-pane", { arg: channelId });
  };

  const openUnread = (event?: { preventDefault?: () => void; stopPropagation?: () => void }) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    createPaneFromTemplate(UNREAD_INBOX_TEMPLATE_ID);
  };

  // The chip opens the conversation it names at the message.
  const target = arriving ?? forYou.latest;
  const openForYou = () => {
    if (!target) return;
    controller.statusPreview.dismiss();
    createPaneFromTemplate("new-chat-pane", {
      arg: target.channelId,
      ...(target.messageId ? { values: { messageId: target.messageId } } : {}),
    });
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

  // Who sent the unread messages is read only while someone is signed in.
  useEffect(() => (signedIn ? controller.trackUnreadPeople() : undefined), [controller, signedIn]);

  return (
    <Box flexDirection="row" paddingRight={1}>
      {!signedIn ? (
        <>
          <CloudStatusIcon />
          <InlineAuthActions showSignup={false} variant="plain" />
        </>
      ) : (
        <>
          {fit && who ? (
            <>
              <Button
                label={`Open the message from ${who.senderName}`}
                variant="plain"
                compact
                flush
                stopPropagation
                onPress={openForYou}
              >
                <Box flexDirection="row" alignItems="center">
                  <Badge label={fit.face.label} icon={fit.face.icon} tone="warning" translate={false} />
                  {arriving && showsMessage ? (
                    // The terminal sizes the message to its cells; the desktop and the web let it shrink to its text and cut it there.
                    <Box {...(nativePaneChrome ? { maxWidth: fit.previewColumns + 1, flexShrink: 1 } : { width: fit.previewColumns + 1, flexShrink: 0 })} minWidth={0}>
                      <ClippedText text={arriving.text} width={fit.previewColumns} lead=" " fg={colors.text} cut={clipToDisplayWidth} />
                    </Box>
                  ) : null}
                </Box>
              </Button>
              <Text>{showsMessage ? "  " : " "}</Text>
            </>
          ) : null}
          <Button label={username ? `Open chat as ${username}` : "Open chat"} variant="plain" compact stopPropagation onPress={openChat}>
            <Text fg={total > 0 ? colors.text : colors.textDim}>
              <Span fg={colors.positive}>@</Span>
              {username ? (
                <>
                  {" "}
                  <Span fg={colors.positive}>{username}</Span>
                </>
              ) : null}
            </Text>
          </Button>
          {rest > 0 ? (
            <Button
              label={`Open ${rest} unread`}
              variant="plain"
              compact
              stopPropagation
              onPress={openUnread}
            >
              <Text fg={colors.textDim}>{` ${rest}`}</Text>
            </Button>
          ) : null}
        </>
      )}
    </Box>
  );
}
