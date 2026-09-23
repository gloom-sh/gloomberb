import { useEffect, useRef } from "react";
import { Box, ScrollBox, Text, TextAttributes, useUiCapabilities, type BoxRenderable, type ScrollBoxRenderable } from "../../../ui";
import { Button, NumberField, SectionHeading, SegmentedControl, TextField } from "../../../components";
import {
  PRESERVED_PASSWORD_HINT,
  type BrokerProfileDraft,
} from "../../../brokers/profile-form";
import { colors } from "../../../theme/colors";
import type { BrokerAdapter, BrokerConfigField } from "../../../types/broker";
import type { BrokerInstanceConfig } from "../../../types/config";
import type { BrokerAccount } from "../../../types/trading";
import { formatCurrency } from "../../../utils/format";
import { t, tf } from "../../../i18n";
import { formatBrokerUpdatedAt, type BrokerProfileRow } from "./model";
import { isBrokerErrorMessage, stateColor, truncate } from "./table";

export type BrokerEditKey = "label" | "enabled" | string;

type RowRef = (node: BoxRenderable | null) => void;

/**
 * Scrolls the detail so the active edit row is in view. The terminal measures
 * rows in cells from the top of the content; the desktop in pixels, since a
 * focused text field scrolls itself but a segmented control does not.
 */
function revealEditRow(scroll: ScrollBoxRenderable | null, top: BoxRenderable | null, row: BoxRenderable | null): void {
  if (!scroll || !top || !row) return;
  const topRect = top.getBoundingClientRect?.();
  const rowRect = row.getBoundingClientRect?.();
  const pixels = topRect && rowRect && scroll.viewportPx && typeof scroll.scrollTopPx === "number";
  const offset = pixels ? rowRect.y - topRect.y : (row.y ?? 0) - (top.y ?? 0);
  const size = pixels ? rowRect.height : row.height ?? 1;
  const viewport = pixels ? scroll.viewportPx!.height : scroll.viewport?.height ?? 0;
  const current = pixels ? scroll.scrollTopPx! : scroll.scrollTop;
  if (viewport <= 0) return;
  let next = current;
  if (offset < current) next = offset;
  else if (offset + size > current + viewport) next = Math.min(offset, offset + size - viewport);
  if (next === current) return;
  if (pixels) scroll.scrollTopPx = Math.max(0, next);
  else scroll.scrollTo(Math.max(0, next));
}

/**
 * The desktop field draws its own focus ring, so the label is plain there. The
 * terminal field label does not change with focus, so it keeps the marker.
 */
function useFieldLabel(): (label: string, focused: boolean) => string {
  const { nativePaneChrome } = useUiCapabilities();
  return (label, focused) => nativePaneChrome ? label : `${focused ? "> " : "  "}${label}`;
}

function BrokerConfigFieldEditor({
  field,
  draft,
  previous,
  adapter,
  focused,
  width,
  scope,
  rowRef,
  onFocus,
  onChange,
  onSubmit,
}: {
  field: BrokerConfigField;
  draft: BrokerProfileDraft;
  previous: BrokerInstanceConfig;
  adapter: BrokerAdapter;
  focused: boolean;
  width: number;
  scope: string;
  rowRef: RowRef;
  onFocus: () => void;
  onChange: (key: string, value: string) => void;
  onSubmit: () => void;
}) {
  const fieldLabel = useFieldLabel();
  const value = draft.values[field.key] ?? "";
  const previousPassword = field.type === "password"
    ? String(((adapter.toConfigValues?.(previous) ?? previous.config)[field.key] ?? "") || "")
    : "";

  if (field.type === "select") {
    return (
      <Box ref={rowRef} flexDirection="column" onMouseDown={onFocus}>
        <Text fg={focused ? colors.textBright : colors.textDim} attributes={focused ? TextAttributes.BOLD : 0}>
          {fieldLabel(t(field.label), focused)}
        </Text>
        <SegmentedControl
          value={value}
          focused={focused}
          options={(field.options ?? []).map((option) => ({ label: t(option.label), value: option.value }))}
          onChange={(nextValue) => onChange(field.key, nextValue)}
          allowEditable
          shortcutScope={scope}
        />
      </Box>
    );
  }

  const Field = field.type === "number" ? NumberField : TextField;
  return (
    <Box ref={rowRef} onMouseDown={onFocus}>
      <Field
        label={fieldLabel(t(field.label), focused)}
        value={value}
        focused={focused}
        width={width}
        type={field.type === "password" ? "password" : "text"}
        placeholder={field.type === "password" && previousPassword ? t(PRESERVED_PASSWORD_HINT) : field.placeholder ? t(field.placeholder) : undefined}
        hint={field.placeholder ? t(field.placeholder) : undefined}
        onChange={(nextValue) => onChange(field.key, nextValue)}
        onSubmit={onSubmit}
      />
    </Box>
  );
}

function accountDetail(account: BrokerAccount): string {
  const parts = [
    account.accountId,
    account.netLiquidation != null ? tf("{value} net liq", { value: formatCurrency(account.netLiquidation, account.currency || "USD") }) : null,
    account.buyingPower != null ? tf("{value} buying power", { value: formatCurrency(account.buyingPower, account.currency || "USD") }) : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

export function BrokerDetailContent({
  row,
  accounts,
  editDraft,
  editFields,
  activeEditKey,
  busy,
  message,
  width,
  editScope,
  paneFocused,
  onActiveEditKeyChange,
  onDraftLabelChange,
  onDraftEnabledChange,
  onDraftValueChange,
  onSaveEdit,
  onCancelEdit,
}: {
  row: BrokerProfileRow | null;
  accounts: BrokerAccount[];
  editDraft: BrokerProfileDraft | null;
  editFields: BrokerConfigField[];
  activeEditKey: BrokerEditKey;
  busy: string | null;
  message: string | null;
  width: number;
  /** The edit form's shortcut scope, shared with the pane's field ring. */
  editScope: string;
  /** The form's fields take keys only while the pane has the keyboard. */
  paneFocused: boolean;
  onActiveEditKeyChange: (key: BrokerEditKey) => void;
  onDraftLabelChange: (label: string) => void;
  onDraftEnabledChange: (enabled: boolean) => void;
  onDraftValueChange: (key: string, value: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
}) {
  const fieldLabel = useFieldLabel();
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const topRef = useRef<BoxRenderable | null>(null);
  const rowRefs = useRef(new Map<BrokerEditKey, BoxRenderable>());
  const rowRef = (key: BrokerEditKey): RowRef => (node) => {
    if (node) rowRefs.current.set(key, node);
    else rowRefs.current.delete(key);
  };
  const editing = !!editDraft;
  const shownEditKey = useRef<BrokerEditKey | null>(null);
  useEffect(() => {
    if (!editing) {
      shownEditKey.current = null;
      return;
    }
    // The form opens at its first field; after that the view follows the active row.
    const previous = shownEditKey.current;
    shownEditKey.current = activeEditKey;
    if (previous === null || previous === activeEditKey) return;
    revealEditRow(scrollRef.current, topRef.current, rowRefs.current.get(activeEditKey) ?? null);
  }, [activeEditKey, editing]);

  if (!row) return <Box flexGrow={1} />;

  // Never wider than the detail pane, so a narrow floating pane shrinks instead of clipping.
  const fieldWidth = Math.max(12, Math.min(34, width - 2));
  const detailStatusMessage = isBrokerErrorMessage(message) ? message : row.message || t("No status message.");
  const editAdapter = row.adapter;

  return (
    <ScrollBox ref={scrollRef} flexGrow={1} scrollY>
      <Box ref={topRef} flexDirection="column" paddingX={1}>
        {/* The stack title already names the profile; the body starts with its state. */}
        <Text fg={stateColor(row.state)} attributes={TextAttributes.BOLD}>
          {truncate(row.stateLabel, width)}
        </Text>
        <Text fg={colors.textDim}>
          {truncate(`${row.brokerName} · ${row.mode} · ${row.id}`, width)}
        </Text>
        <Text
          fg={isBrokerErrorMessage(detailStatusMessage) ? colors.negative : colors.textDim}
          width={width}
          wrapText
        >
          {detailStatusMessage}
        </Text>
        <Text fg={colors.textMuted}>{tf("Last sync {time}", { time: formatBrokerUpdatedAt(row.lastSyncedAt) })}</Text>
        <Text fg={colors.textMuted}>{tf("Status updated {time}", { time: formatBrokerUpdatedAt(row.updatedAt) })}</Text>
        <Box height={1} />

        {editDraft && editAdapter ? (
          <Box flexDirection="column" gap={1}>
            <SectionHeading title="Edit Profile" />
            <Box ref={rowRef("label")} onMouseDown={() => onActiveEditKeyChange("label")}>
              <TextField
                label={fieldLabel(t("Profile Label"), activeEditKey === "label")}
                value={editDraft.label}
                focused={paneFocused && activeEditKey === "label"}
                width={fieldWidth}
                onChange={onDraftLabelChange}
                onSubmit={onSaveEdit}
              />
            </Box>
            <Box ref={rowRef("enabled")} flexDirection="column" onMouseDown={() => onActiveEditKeyChange("enabled")}>
              <Text fg={activeEditKey === "enabled" ? colors.textBright : colors.textDim} attributes={activeEditKey === "enabled" ? TextAttributes.BOLD : 0}>
                {fieldLabel(t("Enabled"), activeEditKey === "enabled")}
              </Text>
              <SegmentedControl
                value={editDraft.enabled ? "yes" : "no"}
                focused={paneFocused && activeEditKey === "enabled"}
                options={[
                  { label: t("Enabled"), value: "yes" },
                  { label: t("Disabled"), value: "no" },
                ]}
                onChange={(value) => onDraftEnabledChange(value === "yes")}
                allowEditable
                shortcutScope={editScope}
              />
            </Box>
            {editFields.map((field) => (
              <BrokerConfigFieldEditor
                key={field.key}
                field={field}
                draft={editDraft}
                previous={row.instance}
                adapter={editAdapter}
                focused={paneFocused && activeEditKey === field.key}
                width={fieldWidth}
                scope={editScope}
                rowRef={rowRef(field.key)}
                onFocus={() => onActiveEditKeyChange(field.key)}
                onChange={onDraftValueChange}
                onSubmit={onSaveEdit}
              />
            ))}
            <Box flexDirection="row" gap={1}>
              <Button label={t("Save")} shortcut="Enter" variant="primary" onPress={onSaveEdit} disabled={!!busy} />
              <Button label={t("Cancel")} shortcut="Esc" variant="secondary" onPress={onCancelEdit} disabled={!!busy} />
            </Box>
          </Box>
        ) : (
          // Edit, test, sync, open and disconnect are the footer's e, c, s, o and d.
          <Box flexDirection="column">
            <SectionHeading title="Accounts" />
            {accounts.length === 0 ? (
              <Text fg={colors.textDim}>{t("No accounts loaded. Test/connect or sync this profile.")}</Text>
            ) : accounts.map((account) => (
              <Text key={account.accountId} fg={colors.textDim}>
                {truncate(accountDetail(account), width)}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    </ScrollBox>
  );
}
