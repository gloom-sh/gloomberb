import { Box, Text } from "../../../../ui";
import { t } from "../../../../i18n";
import { displayWidth } from "../../../../utils/format";
import { chatAuthorName, isDiscordGhost } from "../ghost-user";
import { Button } from "../../../../components/ui";
import { MESSAGE_ACTION_WIDTH } from "../layout";
import type { ChatMessageRenderState } from "./render-state";
import type { ChatMessageBaseProps } from "./types";

type ChatMessageActionProps = Pick<ChatMessageBaseProps, "index" | "beginReplyTo" | "beginEditMessage" | "retryMessage"> & {
  state: ChatMessageRenderState;
};

/** Reply and Edit for one message, or Retry for a failed send: after the header, or floated over the first body line of a grouped message. */
export function ChatMessageActions({
  state,
  index,
  floating = false,
  beginReplyTo,
  beginEditMessage,
  retryMessage,
}: ChatMessageActionProps & { floating?: boolean }) {
  const variant = state.isSelected ? "primary" : "secondary";
  if (state.showRetryAction && retryMessage) {
    return (
      <Box
        {...(floating ? { position: "absolute", top: 0, right: 0 } : {})}
        width={MESSAGE_ACTION_WIDTH}
        height={1}
        flexDirection="row"
        data-gloom-role="chat-message-retry-action"
      >
        <Button stopPropagation
          label={t("Retry")}
          width={MESSAGE_ACTION_WIDTH}
          variant={variant}
          onPress={() => retryMessage(index)}
        />
      </Box>
    );
  }
  if (!state.showReplyAction) return null;
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
  onUserActivate,
  ...actionProps
}: ChatMessageActionProps & Pick<ChatMessageBaseProps, "msg" | "onUserHover" | "onUserHoverEnd" | "onUserActivate"> & {
  /** Host row props: width, background and hover or selection hooks. */
  rowProps: Record<string, unknown>;
  /** The terminal sizes the author cell to its label. */
  fitAuthorWidth?: boolean;
}) {
  const authorLabel = chatAuthorName(msg.user);
  // A Discord ghost has no Gloom profile to open.
  const hasProfile = !isDiscordGhost(msg.user);
  return (
    <Box {...rowProps} flexDirection="row" height={1} paddingLeft={1}>
      <Box
        width={fitAuthorWidth ? displayWidth(authorLabel) : undefined}
        height={1}
        {...(hasProfile
          ? {
            onMouseOver: () => onUserHover(msg.user),
            onMouseMove: () => onUserHover(msg.user),
            onMouseOut: onUserHoverEnd,
            onMouseDown: (event: { preventDefault?: () => void; stopPropagation?: () => void }) => {
              event.preventDefault?.();
              event.stopPropagation?.();
              onUserActivate?.(msg.user);
            },
            style: { cursor: "pointer" },
          }
          : {})}
      >
        <Text fg={state.authorColor} attributes={state.authorAttributes}>
          {authorLabel}
        </Text>
      </Box>
      {msg.origin === "discord" && <Text fg={state.originTagColor}> Discord</Text>}
      <Text fg={state.headerStatusColor}> {state.headerStatus}</Text>
      {(state.showReplyAction || (state.showRetryAction && actionProps.retryMessage)) && <Text fg={state.headerStatusColor}> </Text>}
      <ChatMessageActions state={state} {...actionProps} />
    </Box>
  );
}
