import { Box, Text } from "../../../../ui";
import { t } from "../../../../i18n";
import { Button } from "../../../../components/ui";
import { MESSAGE_ACTION_WIDTH } from "../layout";
import type { ChatMessageRenderState } from "./render-state";
import type { ChatMessageBaseProps } from "./types";

type ChatMessageActionProps = Pick<ChatMessageBaseProps, "index" | "beginReplyTo" | "beginEditMessage"> & {
  state: ChatMessageRenderState;
};

/** Reply and Edit for one message: after the header, or floated over the first body line of a grouped message. */
export function ChatMessageActions({
  state,
  index,
  floating = false,
  beginReplyTo,
  beginEditMessage,
}: ChatMessageActionProps & { floating?: boolean }) {
  if (!state.showReplyAction) return null;
  const variant = state.isSelected ? "primary" : "secondary";
  return (
    <Box
      {...(floating ? { position: "absolute", top: 0, right: 0 } : {})}
      width={MESSAGE_ACTION_WIDTH * (state.showEditAction ? 2 : 1)}
      height={1}
      flexDirection="row"
      data-gloom-role="chat-message-reply-action"
    >
      <Button stopPropagation
        label={t("Reply")}
        width={MESSAGE_ACTION_WIDTH}
        variant={variant}
        onPress={() => beginReplyTo(index)}
      />
      {state.showEditAction && (
        <Button stopPropagation
          label={t("Edit")}
          width={MESSAGE_ACTION_WIDTH}
          variant={variant}
          onPress={() => beginEditMessage(index)}
        />
      )}
    </Box>
  );
}

/** Author, send status and inline actions for the first message of a group. */
export function ChatMessageHeader({
  msg,
  state,
  rowProps,
  fitAuthorWidth = false,
  onUserHover,
  onUserHoverEnd,
  ...actionProps
}: ChatMessageActionProps & Pick<ChatMessageBaseProps, "msg" | "onUserHover" | "onUserHoverEnd"> & {
  /** Host row props: width, background and hover or selection hooks. */
  rowProps: Record<string, unknown>;
  /** The terminal sizes the author cell to its label. */
  fitAuthorWidth?: boolean;
}) {
  const authorLabel = msg.user.username ?? "anon";
  return (
    <Box {...rowProps} flexDirection="row" height={1} paddingLeft={1}>
      <Box
        width={fitAuthorWidth ? authorLabel.length : undefined}
        height={1}
        onMouseOver={() => onUserHover(msg.user)}
        onMouseMove={() => onUserHover(msg.user)}
        onMouseOut={onUserHoverEnd}
        style={{ cursor: "pointer" }}
      >
        <Text fg={state.authorColor} attributes={state.authorAttributes}>
          {authorLabel}
        </Text>
      </Box>
      <Text fg={state.headerStatusColor}> {state.headerStatus}</Text>
      {state.showReplyAction && <Text fg={state.headerStatusColor}> </Text>}
      <ChatMessageActions state={state} {...actionProps} />
    </Box>
  );
}
