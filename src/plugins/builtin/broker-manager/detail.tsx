import { useRef } from "react";
import { Box, ScrollBox, Text, TextAttributes, type BoxRenderable, type ScrollBoxRenderable } from "../../../ui";
import { Button, FieldLabel, NumberField, SectionHeading, SegmentedControl, TextField, useFieldRing } from "../../../components";
import {
  PRESERVED_PASSWORD_HINT,
  type BrokerProfileDraft,
} from "../../../brokers/profile-form";
import { colors } from "../../../theme/colors";
import type { BrokerAdapter, BrokerConfigField } from "../../../types/broker";
import type { BrokerInstanceConfig } from "../../../types/config";
import type { BrokerAccount } from "../../../types/trading";
import { formatRelativeAge } from "../../../utils/datetime-format";
import { formatCurrency, truncateToDisplayWidth } from "../../../utils/format";
import { t, tf } from "../../../i18n";
import type { BrokerProfileRow } from "./model";
import type { BrokerManagerMessage } from "./pane-actions";
import { stateColor } from "./table";

export type BrokerEditKey = "label" | "enabled" | string;

type RowRef = (node: BoxRenderable | null) => void;

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
  const value = draft.values[field.key] ?? "";
  const previousPassword = field.type === "password"
    ? String(((adapter.toConfigValues?.(previous) ?? previous.config)[field.key] ?? "") || "")
    : "";

  if (field.type === "select") {
    return (
      <Box ref={rowRef} flexDirection="column" onMouseDown={onFocus}>
        <FieldLabel label={t(field.label)} active={focused} />
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
        label={t(field.label)}
        active={focused}
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
  editKeys,
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
  /** The edit form's fields in Tab order. */
  editKeys: readonly BrokerEditKey[];
  busy: string | null;
  message: BrokerManagerMessage | null;
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
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  // Tab and j/k walk the fields and go round; Enter, Esc and the select rows'
  // left and right are the pane's (keyboard.ts).
  const { nodeRef: rowRef } = useFieldRing({
    ids: editKeys,
    activeId: activeEditKey,
    onActivate: onActiveEditKeyChange,
    enabled: paneFocused && !!editDraft,
    scope: editScope,
    wrap: true,
    scrollRef,
  });

  if (!row) return <Box flexGrow={1} />;

  // Never wider than the detail pane, so a narrow floating pane shrinks instead of clipping.
  const fieldWidth = Math.max(12, Math.min(34, width - 2));
  // A failed action outranks the profile's own status until the next action.
  const actionError = message?.tone === "error" ? message.text : null;
  const detailStatusMessage = actionError ?? (row.message || t("No status message."));
  const editAdapter = row.adapter;

  return (
    <ScrollBox ref={scrollRef} flexGrow={1} scrollY>
      <Box flexDirection="column" paddingX={1}>
        {/* The stack title already names the profile; the body starts with its state. */}
        <Text fg={stateColor(row.state)} attributes={TextAttributes.BOLD}>
          {truncateToDisplayWidth(row.stateLabel, width)}
        </Text>
        <Text fg={colors.textDim}>
          {truncateToDisplayWidth(`${row.brokerName} · ${row.mode} · ${row.id}`, width)}
        </Text>
        <Text
          fg={actionError || row.state === "error" ? colors.negative : colors.textDim}
          width={width}
          wrapText
        >
          {detailStatusMessage}
        </Text>
        <Text fg={colors.textMuted}>{tf("Last sync {time}", { time: formatRelativeAge(row.lastSyncedAt) })}</Text>
        <Text fg={colors.textMuted}>{tf("Status updated {time}", { time: formatRelativeAge(row.updatedAt) })}</Text>
        <Box height={1} />

        {editDraft && editAdapter ? (
          <Box flexDirection="column" gap={1}>
            <SectionHeading title="Edit Profile" />
            <Box ref={rowRef("label")} onMouseDown={() => onActiveEditKeyChange("label")}>
              <TextField
                label={t("Profile Label")}
                active={activeEditKey === "label"}
                value={editDraft.label}
                focused={paneFocused && activeEditKey === "label"}
                width={fieldWidth}
                onChange={onDraftLabelChange}
                onSubmit={onSaveEdit}
              />
            </Box>
            <Box ref={rowRef("enabled")} flexDirection="column" onMouseDown={() => onActiveEditKeyChange("enabled")}>
              <FieldLabel label={t("Enabled")} active={activeEditKey === "enabled"} />
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
                {truncateToDisplayWidth(accountDetail(account), width)}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    </ScrollBox>
  );
}
