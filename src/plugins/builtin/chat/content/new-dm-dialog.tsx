import { useEffect, useMemo, useRef, useState } from "react";
import { Button, DialogFrame, ListView, TextField, type ListViewItem } from "../../../../components/ui";
import { stepListCursor } from "../../../../components/ui/list-view";
import { modalSurfaceStyle } from "../../../../components/ui/frame";
import { useShortcut } from "../../../../react/input";
import { colors, hoverBg } from "../../../../theme/colors";
import { t } from "../../../../i18n";
import { Box, Text, TextAttributes, useUiCapabilities, type InputRenderable } from "../../../../ui";
import type { ChatChannel, ChatUserSummary } from "../../../../api-client";
import { isPlainKey } from "../../../../utils/keyboard";
import { truncateWithEllipsis } from "../../../../utils/text-wrap";
import {
  hasOnlyDmUsernameArgs,
  parseDmUsernames,
} from "../channels";
import {
  describeConversationStartError,
  directMessageAvailability,
  knownConversationRefusal,
  type DirectMessageAvailability,
} from "../direct-messages";

const MAX_RECENT_USERS = 6;
const MIN_DIALOG_WIDTH = 32;
const MAX_DIALOG_WIDTH = 52;
const DIALOG_HEIGHT = 13;
/** Rows around the list: border, title, field, label, action row. */
const DIALOG_CHROME_ROWS = 7;
/** The key line under the dialog, with its spacer. */
const DIALOG_KEYS_ROWS = 2;

export interface DmUserCandidate {
  username: string;
  displayName: string;
  availability: DirectMessageAvailability;
}

function normalizeUsername(value: string | null | undefined): string {
  return value?.trim().replace(/^@+/, "").toLowerCase() ?? "";
}

function currentTokenQuery(value: string): string {
  const token = value.split(/[\s,]+/).at(-1) ?? "";
  return normalizeUsername(token);
}

/**
 * Everyone the chat has seen but you, by username. A user whose settings
 * refuse a DM from you carries that reason, so the list can show it before
 * anything is sent; one you already share a DM with opens it.
 */
export function candidateUsers(
  userByUsername: ReadonlyMap<string, ChatUserSummary>,
  currentUserId: string | null | undefined,
  channels: readonly ChatChannel[],
): DmUserCandidate[] {
  const candidates = new Map<string, DmUserCandidate>();
  for (const [key, user] of userByUsername) {
    const availability = directMessageAvailability(user, { currentUserId, channels });
    if (availability.kind === "self") continue;
    const username = normalizeUsername(user.username ?? key);
    if (!username) continue;
    candidates.set(username, {
      username,
      displayName: user.displayName?.trim() || `@${username}`,
      availability,
    });
  }
  return [...candidates.values()].sort((left, right) => left.username.localeCompare(right.username));
}

function setUsernameSelected(value: string, username: string, selected: boolean): string {
  const usernames = parseDmUsernames(value).filter((existing) => existing !== username);
  if (selected) usernames.push(username);
  return usernames.map((entry) => `@${entry}`).join(" ") + (usernames.length > 0 ? " " : "");
}

function usernamesLabel(usernames: string[], width: number): string {
  return truncateWithEllipsis(usernames.map((username) => `@${username}`).join(" "), width);
}

export function NewDmDialog({
  width,
  height,
  userByUsername,
  currentUserId,
  channels,
  onCancel,
  onOpenChannel,
  onSubmit,
}: {
  width: number;
  height: number;
  userByUsername: Map<string, ChatUserSummary>;
  currentUserId?: string | null;
  /** The conversations you are in, so a DM you already share opens instead of being started. */
  channels: readonly ChatChannel[];
  onCancel: () => void;
  onOpenChannel: (channelId: string) => void;
  onSubmit: (usernames: string[]) => Promise<void>;
}) {
  const { nativePaneChrome } = useUiCapabilities();
  const inputRef = useRef<InputRenderable | null>(null);
  const [value, setValue] = useState("");
  const valueRef = useRef("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  // Enter reaches both the field's submit and the dialog's key handler.
  const submittingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const dialogWidth = Math.max(MIN_DIALOG_WIDTH, Math.min(MAX_DIALOG_WIDTH, width - 4));
  const dialogHeight = Math.min(DIALOG_HEIGHT, Math.max(8, height - 2));
  const left = Math.max(0, Math.floor((width - dialogWidth) / 2));
  const top = Math.max(0, Math.floor((height - dialogHeight) / 2));
  const contentWidth = Math.max(1, dialogWidth - 4);
  // A short terminal pane keeps the list and drops the key line.
  const showKeys = nativePaneChrome || dialogHeight - DIALOG_CHROME_ROWS - DIALOG_KEYS_ROWS >= 2;
  const selectedUsernames = useMemo(() => parseDmUsernames(value), [value]);
  const selectedUsernameSet = useMemo(() => new Set(selectedUsernames), [selectedUsernames]);
  const allCandidates = useMemo(
    () => candidateUsers(userByUsername, currentUserId, channels),
    [channels, currentUserId, userByUsername],
  );
  const query = currentTokenQuery(value);
  const visibleCandidates = useMemo(() => {
    const filtered = query
      ? allCandidates.filter((candidate) => candidate.username.includes(query))
      : allCandidates;
    return filtered.slice(0, MAX_RECENT_USERS);
  }, [allCandidates, query]);
  const items = useMemo<ListViewItem[]>(() => visibleCandidates.map((candidate) => {
    const refused = candidate.availability.kind === "refused";
    return {
      id: candidate.username,
      label: `@${candidate.username}`,
      detail: refused ? t("no DMs") : candidate.displayName,
      checked: selectedUsernameSet.has(candidate.username),
      disabled: refused,
    };
  }), [selectedUsernameSet, visibleCandidates]);
  // A name the chat already knows cannot be messaged: say why as it is typed.
  const knownRefusal = useMemo(
    () => knownConversationRefusal(selectedUsernames, { userByUsername, currentUserId, channels }),
    [channels, currentUserId, selectedUsernames, userByUsername],
  );
  const shownError = error ?? knownRefusal;
  const canSubmit = hasOnlyDmUsernameArgs(value) && selectedUsernames.length > 0 && !submitting && !knownRefusal;

  useEffect(() => {
    inputRef.current?.focus?.();
  }, []);

  // The cursor never rests on a user who cannot be picked.
  useEffect(() => {
    setSelectedIndex((current) => {
      const clamped = Math.max(0, Math.min(current, items.length - 1));
      if (!items[clamped]?.disabled) return clamped;
      const next = stepListCursor(items, clamped, 1);
      return next !== clamped ? next : stepListCursor(items, clamped, -1);
    });
  }, [items]);
  const highlightedItem = items[selectedIndex] && !items[selectedIndex]!.disabled ? items[selectedIndex] : undefined;

  const updateValue = (nextValue: string) => {
    valueRef.current = nextValue;
    setValue(nextValue);
  };

  const toggleCandidate = (username: string) => {
    updateValue(setUsernameSelected(valueRef.current, username, !parseDmUsernames(valueRef.current).includes(username)));
    setError(null);
    queueMicrotask(() => inputRef.current?.focus?.());
  };

  const submit = async () => {
    if (submittingRef.current) return;
    let submittedValue = valueRef.current;
    // Nothing typed yet: Enter starts with the highlighted user, as Tab would
    // have picked them.
    if (highlightedItem && parseDmUsernames(submittedValue).length === 0 && currentTokenQuery(submittedValue) === "") {
      submittedValue = setUsernameSelected(submittedValue, highlightedItem.id, true);
      updateValue(submittedValue);
    }
    const submittedUsernames = parseDmUsernames(submittedValue);
    if (!hasOnlyDmUsernameArgs(submittedValue) || submittedUsernames.length === 0) {
      setError(t("Enter at least one @username."));
      return;
    }
    const refusal = knownConversationRefusal(submittedUsernames, { userByUsername, currentUserId, channels });
    if (refusal) {
      setError(refusal);
      return;
    }
    const onlyUser = submittedUsernames.length === 1 ? userByUsername.get(submittedUsernames[0]!) : undefined;
    const availability = onlyUser ? directMessageAvailability(onlyUser, { currentUserId, channels }) : null;
    if (availability?.kind === "open") {
      // The dialog closes with it; a second Enter in the same press opens nothing more.
      submittingRef.current = true;
      onOpenChannel(availability.channelId);
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(submittedUsernames);
    } catch (submitError) {
      setError(describeConversationStartError(submitError, submittedUsernames, userByUsername));
      setSubmitting(false);
    } finally {
      submittingRef.current = false;
    }
  };

  useShortcut((event) => {
    if (event.name === "escape") {
      event.preventDefault?.();
      event.stopPropagation?.();
      onCancel();
      return;
    }
    if (isPlainKey(event, "up", "down")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      setSelectedIndex((current) => (items.length === 0 ? 0 : stepListCursor(items, current, event.name === "up" ? -1 : 1)));
      return;
    }
    if (event.name === "tab" && highlightedItem) {
      event.preventDefault?.();
      event.stopPropagation?.();
      toggleCandidate(highlightedItem.id);
      return;
    }
    if (event.name === "enter" || event.name === "return") {
      event.preventDefault?.();
      event.stopPropagation?.();
      void submit();
    }
  }, { allowEditable: true, phase: "before" });

  return (
    <Box
      position="absolute"
      left={left}
      top={top}
      width={dialogWidth}
      height={nativePaneChrome ? undefined : dialogHeight}
      flexDirection="column"
      {...(nativePaneChrome ? {} : { border: true, borderColor: colors.borderFocused, backgroundColor: colors.bg, paddingX: 1 })}
      onMouseDown={(event: any) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
      }}
      style={nativePaneChrome
        ? { ...modalSurfaceStyle(colors, { padding: 0, width: `calc(${dialogWidth} * var(--cell-w))` }), zIndex: 8 }
        : { zIndex: 8 }}
    >
      <DialogFrame
        title="New DM"
        onClose={onCancel}
        footer={showKeys ? items.length > 0 ? "Tab add · Enter start" : "Enter start" : undefined}
      >
        <TextField
          inputRef={inputRef}
          value={value}
          placeholder="@username, @second"
          focused
          width={contentWidth}
          backgroundColor={colors.panel}
          onChange={(nextValue) => {
            updateValue(nextValue);
            setError(null);
          }}
          onSubmit={() => { void submit(); }}
        />
        <Box height={1}>
          <Text fg={selectedUsernames.length > 0 ? colors.textMuted : colors.textDim}>
            {selectedUsernames.length > 0 ? usernamesLabel(selectedUsernames, contentWidth) : t("Recent users")}
          </Text>
        </Box>
        <ListView
          items={items}
          selectedIndex={highlightedItem ? selectedIndex : -1}
          height={Math.max(1, dialogHeight - DIALOG_CHROME_ROWS - (showKeys ? DIALOG_KEYS_ROWS : 0))}
          bgColor={colors.bg}
          selectedBgColor={colors.selected}
          hoverBgColor={hoverBg()}
          emptyMessage={t("No recent users")}
          selectOnHover
          onSelect={setSelectedIndex}
          onActivate={(item) => toggleCandidate(item.id)}
          renderRow={(item, state) => (
            <Box flexDirection="row" width={contentWidth}>
              <Text fg={state.selected ? colors.selectedText : colors.textDim}>
                {item.disabled ? "  " : item.checked ? "x " : "+ "}
              </Text>
              <Text
                fg={state.selected ? colors.text : state.disabled ? colors.textDim : colors.textMuted}
                attributes={state.selected ? TextAttributes.BOLD : 0}
              >
                {truncateWithEllipsis(item.label, Math.max(1, contentWidth - 12))}
              </Text>
              <Box flexGrow={1} />
              {item.detail ? (
                <Text fg={colors.textDim}>{truncateWithEllipsis(item.detail, 10)}</Text>
              ) : null}
            </Box>
          )}
        />
        <Box height={1} flexDirection="row">
          {shownError ? (
            <Text fg={colors.negative}>{truncateWithEllipsis(shownError, contentWidth)}</Text>
          ) : (
            <Text fg={colors.textDim}>{selectedUsernames.length > 1 ? t("Group chat") : t("Direct message")}</Text>
          )}
          <Box flexGrow={1} />
          <Button
            label={submitting ? t("Starting") : t("Start")}
            width={submitting ? 10 : 7}
            variant="primary"
            disabled={!canSubmit}
            stopPropagation
            onPress={() => { void submit(); }}
          />
        </Box>
      </DialogFrame>
    </Box>
  );
}
