import { useEffect, useMemo, useRef, useState } from "react";
import { Button, ListView, SectionHeading, TextField, type ListViewItem } from "../../../../components/ui";
import { useShortcut } from "../../../../react/input";
import { colors, hoverBg } from "../../../../theme/colors";
import { t } from "../../../../i18n";
import { Box, Text, TextAttributes, type InputRenderable } from "../../../../ui";
import type { ChatUserSummary } from "../../../../api-client";
import { isPlainKey } from "../../../../utils/keyboard";
import {
  hasOnlyDmUsernameArgs,
  parseDmUsernames,
  truncateChannelLabel,
} from "../channels";

const MAX_RECENT_USERS = 6;
const MIN_DIALOG_WIDTH = 32;
const MAX_DIALOG_WIDTH = 52;
const DIALOG_HEIGHT = 10;

interface DmUserCandidate {
  username: string;
  displayName: string;
}

function normalizeUsername(value: string | null | undefined): string {
  return value?.trim().replace(/^@+/, "").toLowerCase() ?? "";
}

function currentTokenQuery(value: string): string {
  const token = value.split(/[\s,]+/).at(-1) ?? "";
  return normalizeUsername(token);
}

function candidateUsers(
  userByUsername: Map<string, ChatUserSummary>,
  currentUserId: string | null | undefined,
): DmUserCandidate[] {
  const candidates = new Map<string, DmUserCandidate>();
  for (const [key, user] of userByUsername) {
    if (currentUserId && user.id === currentUserId) continue;
    const username = normalizeUsername(user.username ?? key);
    if (!username) continue;
    candidates.set(username, {
      username,
      displayName: user.displayName?.trim() || `@${username}`,
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
  return truncateChannelLabel(usernames.map((username) => `@${username}`).join(" "), width);
}

export function NewDmDialog({
  width,
  height,
  userByUsername,
  currentUserId,
  onCancel,
  onSubmit,
}: {
  width: number;
  height: number;
  userByUsername: Map<string, ChatUserSummary>;
  currentUserId?: string | null;
  onCancel: () => void;
  onSubmit: (usernames: string[]) => Promise<void>;
}) {
  const inputRef = useRef<InputRenderable | null>(null);
  const [value, setValue] = useState("");
  const valueRef = useRef("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogWidth = Math.max(MIN_DIALOG_WIDTH, Math.min(MAX_DIALOG_WIDTH, width - 4));
  const dialogHeight = Math.min(DIALOG_HEIGHT, Math.max(7, height - 2));
  const left = Math.max(0, Math.floor((width - dialogWidth) / 2));
  const top = Math.max(0, Math.floor((height - dialogHeight) / 2));
  const contentWidth = Math.max(1, dialogWidth - 4);
  const selectedUsernames = useMemo(() => parseDmUsernames(value), [value]);
  const selectedUsernameSet = useMemo(() => new Set(selectedUsernames), [selectedUsernames]);
  const allCandidates = useMemo(() => candidateUsers(userByUsername, currentUserId), [currentUserId, userByUsername]);
  const query = currentTokenQuery(value);
  const visibleCandidates = useMemo(() => {
    const filtered = query
      ? allCandidates.filter((candidate) => candidate.username.includes(query))
      : allCandidates;
    return filtered.slice(0, MAX_RECENT_USERS);
  }, [allCandidates, query]);
  const items = useMemo<ListViewItem[]>(() => visibleCandidates.map((candidate) => ({
    id: candidate.username,
    label: `@${candidate.username}`,
    detail: candidate.displayName,
    checked: selectedUsernameSet.has(candidate.username),
  })), [selectedUsernameSet, visibleCandidates]);
  const canSubmit = hasOnlyDmUsernameArgs(value) && selectedUsernames.length > 0 && !submitting;

  useEffect(() => {
    inputRef.current?.focus?.();
  }, []);

  useEffect(() => {
    setSelectedIndex((current) => Math.max(0, Math.min(current, Math.max(items.length - 1, 0))));
  }, [items.length]);

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
    const submittedValue = valueRef.current;
    const submittedUsernames = parseDmUsernames(submittedValue);
    if (!hasOnlyDmUsernameArgs(submittedValue) || submittedUsernames.length === 0 || submitting) {
      setError(t("Enter at least one @username."));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(submittedUsernames);
    } catch {
      setError(t("Could not start conversation."));
      setSubmitting(false);
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
      setSelectedIndex((current) => {
        if (items.length === 0) return 0;
        return event.name === "up"
          ? Math.max(0, current - 1)
          : Math.min(items.length - 1, current + 1);
      });
      return;
    }
    if (event.name === "tab" && items[selectedIndex]) {
      event.preventDefault?.();
      event.stopPropagation?.();
      toggleCandidate(items[selectedIndex]!.id);
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
      height={dialogHeight}
      flexDirection="column"
      border
      borderColor={colors.borderFocused}
      backgroundColor={colors.bg}
      paddingX={1}
      onMouseDown={(event: any) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
      }}
      style={{ zIndex: 8 }}
    >
      <Box height={1} flexDirection="row">
        <SectionHeading title="New DM" />
        <Box flexGrow={1} />
        <Button label={t("Close")} displayLabel="×" width={3} compact stopPropagation onPress={onCancel} />
      </Box>
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
        selectedIndex={items.length > 0 ? selectedIndex : -1}
        height={Math.max(1, dialogHeight - 6)}
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
              {item.checked ? "x " : "+ "}
            </Text>
            <Text
              fg={state.selected ? colors.text : colors.textMuted}
              attributes={state.selected ? TextAttributes.BOLD : 0}
            >
              {truncateChannelLabel(item.label, Math.max(1, contentWidth - 12))}
            </Text>
            <Box flexGrow={1} />
            {item.detail ? (
              <Text fg={colors.textDim}>{truncateChannelLabel(item.detail, 10)}</Text>
            ) : null}
          </Box>
        )}
      />
      <Box height={1} flexDirection="row">
        {error ? (
          <Text fg={colors.negative}>{truncateChannelLabel(error, contentWidth)}</Text>
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
    </Box>
  );
}
