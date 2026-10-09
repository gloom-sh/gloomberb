import { useEffect, useMemo, useRef, useState } from "react";
import { Button, DialogFrame, Icon, ListView, TextField, type ListViewItem } from "../../../../components/ui";
import { stepListCursor } from "../../../../components/ui/list-view";
import { modalSurfaceStyle } from "../../../../components/ui/frame";
import { useShortcut } from "../../../../react/input";
import { colors, hoverBg } from "../../../../theme/colors";
import { t } from "../../../../i18n";
import { Box, Text, TextAttributes, useUiCapabilities, type InputRenderable } from "../../../../ui";
import type { ChatChannel, ChatUserSummary } from "../../../../api-client";
import { isPlainKey } from "../../../../utils/keyboard";
import { truncateWithEllipsis, wrapTextLines } from "../../../../utils/text-wrap";
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
const START_BUTTON_WIDTH = 7;
/** An error gets two lines in the terminal before it is cut. */
const MAX_STATUS_ROWS = 2;
/** Terminal rows around the list and the status line: border, title and its spacer, field, list header. */
const TERMINAL_CHROME_ROWS = 6;
/** The key line under the dialog, with its spacer. */
const TERMINAL_KEYS_ROWS = 2;
/** The desktop list row, as tall as the multi-select dialog's. */
const DESKTOP_ROW_HEIGHT = 1.35;
const ELLIPSIS_STYLE = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;

interface DmUserCandidate {
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
function candidateUsers(
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

function clampLines(text: string, width: number, maxLines: number): string[] {
  const lines = wrapTextLines(text, width);
  if (lines.length <= maxLines) return lines.length > 0 ? lines : [""];
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = truncateWithEllipsis(`${kept[maxLines - 1]} ${lines[maxLines]}`, width);
  return kept;
}

/**
 * Terminal rows for the dialog in a pane `paneHeight` rows tall: the list
 * shows up to six users; a short pane drops the key line first, then list
 * rows, which scroll.
 */
function terminalDialogLayout(paneHeight: number, itemCount: number, statusRows: number) {
  const available = Math.max(TERMINAL_CHROME_ROWS + statusRows + 1, paneHeight - 2);
  const wantedListRows = Math.max(1, Math.min(itemCount, MAX_RECENT_USERS));
  const roomWithKeys = available - TERMINAL_CHROME_ROWS - statusRows - TERMINAL_KEYS_ROWS;
  const showKeys = roomWithKeys >= Math.min(wantedListRows, 2);
  const listHeight = Math.max(1, Math.min(wantedListRows, showKeys ? roomWithKeys : available - TERMINAL_CHROME_ROWS - statusRows));
  return {
    showKeys,
    listHeight,
    dialogHeight: TERMINAL_CHROME_ROWS + listHeight + statusRows + (showKeys ? TERMINAL_KEYS_ROWS : 0),
  };
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
  // Holds off a second request while one is out, and a second open of a shared DM.
  const submittingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const dialogWidth = Math.max(MIN_DIALOG_WIDTH, Math.min(MAX_DIALOG_WIDTH, width - 4));
  const contentWidth = Math.max(1, dialogWidth - 4);
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

  const header = selectedUsernames.length > 0
    ? selectedUsernames.map((username) => `@${username}`).join(" ")
    : t("Recent users");
  const status = shownError ?? (selectedUsernames.length > 1 ? t("Group chat") : t("Direct message"));
  const startButton = (
    <Button
      label={submitting ? t("Starting") : t("Start")}
      width={submitting ? 10 : START_BUTTON_WIDTH}
      variant="primary"
      disabled={!canSubmit}
      stopPropagation
      onPress={() => { void submit(); }}
    />
  );
  const field = (
    <TextField
      inputRef={inputRef}
      value={value}
      placeholder="@username, @second"
      focused
      width={nativePaneChrome ? undefined : contentWidth}
      backgroundColor={colors.panel}
      onChange={(nextValue) => {
        updateValue(nextValue);
        setError(null);
      }}
    />
  );
  const list = (listHeight: number | undefined) => {
    const scrollable = nativePaneChrome || (listHeight ?? 0) < items.length;
    // The terminal's scroll bar takes the last column.
    const rowWidth = scrollable ? contentWidth - 1 : contentWidth;
    return (
      <ListView
        items={items}
        selectedIndex={highlightedItem ? selectedIndex : -1}
        height={listHeight}
        scrollable={scrollable}
        surface="plain"
        rowGap={0}
        rowHeight={nativePaneChrome ? DESKTOP_ROW_HEIGHT : undefined}
        bgColor={colors.bg}
        selectedBgColor={colors.selected}
        hoverBgColor={hoverBg()}
        emptyMessage={t("No recent users")}
        selectOnHover
        onSelect={setSelectedIndex}
        onActivate={(item) => toggleCandidate(item.id)}
        renderRow={(item, state) => (
          <Box flexDirection="row" alignItems={nativePaneChrome ? "center" : undefined} width={nativePaneChrome ? "100%" : rowWidth} minWidth={0}>
            <Box width={2} flexShrink={0}>
              {state.disabled ? null : (
                <Icon name={item.checked ? "check" : "plus"} size={11} color={state.selected ? colors.selectedText : colors.textDim} />
              )}
            </Box>
            <Text
              fg={state.selected ? colors.text : state.disabled ? colors.textDim : colors.textMuted}
              attributes={state.selected ? TextAttributes.BOLD : 0}
              style={nativePaneChrome ? ELLIPSIS_STYLE : undefined}
            >
              {nativePaneChrome ? item.label : truncateWithEllipsis(item.label, Math.max(1, rowWidth - 14))}
            </Text>
            <Box flexGrow={1} minWidth={1} />
            {item.detail ? (
              <Text fg={colors.textDim} style={nativePaneChrome ? { ...ELLIPSIS_STYLE, maxWidth: "45%" } : undefined}>
                {nativePaneChrome ? item.detail : truncateWithEllipsis(item.detail, 10)}
              </Text>
            ) : null}
          </Box>
        )}
      />
    );
  };
  const footer = items.length > 0 ? "Tab add · Enter start" : "Enter start";
  const stopPointer = (event: any) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
  };

  if (nativePaneChrome) {
    // Sized and centered by the browser in the pane: the frame's padding and
    // the rows are pixels here, so cell arithmetic would misplace both. In a
    // short pane the list gives up its rows first and scrolls.
    return (
      <Box
        position="absolute"
        left={0}
        top={0}
        width="100%"
        height="100%"
        alignItems="center"
        justifyContent="center"
        style={{ zIndex: 8, padding: 8, pointerEvents: "none" }}
      >
        <Box
          flexDirection="column"
          onMouseDown={stopPointer}
          style={{
            ...modalSurfaceStyle(colors, { padding: 0, width: `min(calc(${MAX_DIALOG_WIDTH} * var(--cell-w)), 100%)`, maxHeight: "100%" }),
            pointerEvents: "auto",
          }}
        >
          <DialogFrame title="New DM" onClose={onCancel} footer={footer} shrinkable>
            <Box flexDirection="column" flexShrink={1} minHeight={0} style={{ gap: 6 }}>
              {field}
              <Text fg={selectedUsernames.length > 0 ? colors.textMuted : colors.textDim} style={ELLIPSIS_STYLE}>
                {header}
              </Text>
              {list(undefined)}
              <Box flexDirection="row" alignItems="center" flexShrink={0} style={{ gap: 12, marginTop: 4 }}>
                <Text fg={shownError ? colors.negative : colors.textDim} wrapText style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
                  {status}
                </Text>
                {startButton}
              </Box>
            </Box>
          </DialogFrame>
        </Box>
      </Box>
    );
  }

  const statusWidth = Math.max(1, contentWidth - START_BUTTON_WIDTH - 1);
  const statusLines = clampLines(status, statusWidth, MAX_STATUS_ROWS);
  const layout = terminalDialogLayout(height, items.length, statusLines.length);
  return (
    <Box
      position="absolute"
      left={Math.max(0, Math.floor((width - dialogWidth) / 2))}
      top={Math.max(0, Math.floor((height - layout.dialogHeight) / 2))}
      width={dialogWidth}
      height={layout.dialogHeight}
      flexDirection="column"
      border
      borderColor={colors.borderFocused}
      backgroundColor={colors.bg}
      paddingX={1}
      onMouseDown={stopPointer}
      style={{ zIndex: 8 }}
    >
      <DialogFrame title="New DM" onClose={onCancel} footer={layout.showKeys ? footer : undefined}>
        {field}
        <Box height={1}>
          <Text fg={selectedUsernames.length > 0 ? colors.textMuted : colors.textDim}>
            {truncateWithEllipsis(header, contentWidth)}
          </Text>
        </Box>
        {list(layout.listHeight)}
        <Box height={statusLines.length} flexDirection="row">
          <Box width={statusWidth} flexDirection="column">
            {statusLines.map((line, index) => (
              <Text key={index} fg={shownError ? colors.negative : colors.textDim}>{line}</Text>
            ))}
          </Box>
          <Box flexGrow={1} />
          {startButton}
        </Box>
      </DialogFrame>
    </Box>
  );
}
