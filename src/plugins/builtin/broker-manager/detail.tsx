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
  /** The profile being edited; none while adding one. */
  previous: BrokerInstanceConfig | null;
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
  const previousPassword = field.type === "password" && previous
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
        // The placeholder already says it; a stored password's placeholder says "unchanged" instead.
        hint={field.type === "password" && previousPassword && field.placeholder ? t(field.placeholder) : undefined}
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

/**
 * A broker profile's fields and the buttons that save them: editing a profile
 * (with its Enabled switch) or adding one (Connect). Enter saves, Esc cancels.
 */
export function BrokerProfileForm({
  adapter,
  draft,
  fields,
  previous,
  activeKey,
  busy,
  width,
  scope,
  paneFocused,
  submitLabel,
  rowRef,
  onActiveKeyChange,
  onLabelChange,
  onEnabledChange,
  onValueChange,
  onSubmit,
  onCancel,
}: {
  adapter: BrokerAdapter;
  draft: BrokerProfileDraft;
  fields: BrokerConfigField[];
  previous: BrokerInstanceConfig | null;
  activeKey: BrokerEditKey;
  busy: string | null;
  /** Columns a text field may take. */
  width: number;
  /** The form's shortcut scope, shared with the pane's field ring. */
  scope: string;
  /** The form's fields take keys only while the pane has the keyboard. */
  paneFocused: boolean;
  submitLabel: string;
  /** Each field's outer box, for the form's field ring to scroll into view. */
  rowRef: (key: BrokerEditKey) => RowRef;
  onActiveKeyChange: (key: BrokerEditKey) => void;
  onLabelChange: (label: string) => void;
  /** Editing only: a new profile starts enabled. */
  onEnabledChange?: (enabled: boolean) => void;
  onValueChange: (key: string, value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <Box ref={rowRef("label")} onMouseDown={() => onActiveKeyChange("label")}>
        <TextField
          label={t("Profile Label")}
          active={activeKey === "label"}
          value={draft.label}
          focused={paneFocused && activeKey === "label"}
          width={width}
          onChange={onLabelChange}
          onSubmit={onSubmit}
        />
      </Box>
      {onEnabledChange && (
        <Box ref={rowRef("enabled")} flexDirection="column" onMouseDown={() => onActiveKeyChange("enabled")}>
          <FieldLabel label={t("Enabled")} active={activeKey === "enabled"} />
          <SegmentedControl
            value={draft.enabled ? "yes" : "no"}
            focused={paneFocused && activeKey === "enabled"}
            options={[
              { label: t("Enabled"), value: "yes" },
              { label: t("Disabled"), value: "no" },
            ]}
            onChange={(value) => onEnabledChange(value === "yes")}
            allowEditable
            shortcutScope={scope}
          />
        </Box>
      )}
      {fields.map((field) => (
        <BrokerConfigFieldEditor
          key={field.key}
          field={field}
          draft={draft}
          previous={previous}
          adapter={adapter}
          focused={paneFocused && activeKey === field.key}
          width={width}
          scope={scope}
          rowRef={rowRef(field.key)}
          onFocus={() => onActiveKeyChange(field.key)}
          onChange={onValueChange}
          onSubmit={onSubmit}
        />
      ))}
      <Box flexDirection="row" gap={1}>
        <Button label={submitLabel} shortcut="Enter" variant="primary" onPress={onSubmit} disabled={!!busy} />
        <Button label={t("Cancel")} shortcut="Esc" variant="secondary" onPress={onCancel} disabled={!!busy} />
      </Box>
    </>
  );
}

/** Never wider than the pane, so a narrow floating pane shrinks a field instead of clipping it. */
export function profileFieldWidth(width: number): number {
  return Math.max(12, Math.min(34, width - 2));
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
            <BrokerProfileForm
              adapter={editAdapter}
              draft={editDraft}
              fields={editFields}
              previous={row.instance}
              activeKey={activeEditKey}
              busy={busy}
              width={profileFieldWidth(width)}
              scope={editScope}
              paneFocused={paneFocused}
              submitLabel={t("Save")}
              rowRef={rowRef}
              onActiveKeyChange={onActiveEditKeyChange}
              onLabelChange={onDraftLabelChange}
              onEnabledChange={onDraftEnabledChange}
              onValueChange={onDraftValueChange}
              onSubmit={onSaveEdit}
              onCancel={onCancelEdit}
            />
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
