import { Box, Text, useUiCapabilities } from "../../../../ui";
import { t } from "../../../../i18n";
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
  onUserContextMenu,
  ...actionProps
}: ChatMessageActionProps & Pick<ChatMessageBaseProps, "msg" | "onUserHover" | "onUserHoverEnd" | "onUserActivate" | "onUserContextMenu"> & {
  /** Host row props: width, background and hover or selection hooks. */
  rowProps: Record<string, unknown>;
  /** The terminal sizes the author cell to its label. */
  fitAuthorWidth?: boolean;
}) {
  const authorLabel = msg.user.username ?? "anon";
  const { nativeContextMenu } = useUiCapabilities();
  return (
    <Box {...rowProps} flexDirection="row" height={1} paddingLeft={1}>
      <Box
        width={fitAuthorWidth ? authorLabel.length : undefined}
        height={1}
        onMouseOver={() => onUserHover(msg.user)}
        onMouseMove={() => onUserHover(msg.user)}
        onMouseOut={onUserHoverEnd}
        data-gloom-context-menu-surface="true"
        onMouseDown={(event: { button?: number; preventDefault?: () => void; stopPropagation?: () => void }) => {
          event.preventDefault?.();
          event.stopPropagation?.();
          // A native menu opens on the right-click's contextmenu event instead.
          if (event.button === 2 && nativeContextMenu === true) return;
          onUserActivate?.(msg.user);
        }}
        onContextMenu={(event: { preventDefault?: () => void; stopPropagation?: () => void }) => onUserContextMenu?.(msg.user, event)}
        style={{ cursor: "pointer" }}
      >
        <Text fg={state.authorColor} attributes={state.authorAttributes}>
          {authorLabel}
        </Text>
      </Box>
      <Text fg={state.headerStatusColor}> {state.headerStatus}</Text>
      {(state.showReplyAction || (state.showRetryAction && actionProps.retryMessage)) && <Text fg={state.headerStatusColor}> </Text>}
      <ChatMessageActions state={state} {...actionProps} />
    </Box>
  );
}
