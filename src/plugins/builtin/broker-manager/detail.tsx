import { Box, ScrollBox, Text, TextAttributes } from "../../../ui";
import { Button, NumberField, SegmentedControl, TextField } from "../../../components";
import {
  PRESERVED_PASSWORD_HINT,
  type BrokerProfileDraft,
} from "../../../brokers/profile-form";
import { colors } from "../../../theme/colors";
import type { BrokerAdapter, BrokerConfigField, BrokerProfileAction } from "../../../types/broker";
import type { BrokerInstanceConfig } from "../../../types/config";
import type { BrokerAccount } from "../../../types/trading";
import { formatCurrency } from "../../../utils/format";
import { t, tf } from "../../../i18n";
import { formatBrokerUpdatedAt, type BrokerProfileRow } from "./model";
import { isBrokerErrorMessage, stateColor, truncate } from "./table";

export type BrokerEditKey = "label" | "enabled" | string;

function brokerFieldLabel(field: BrokerConfigField, focused: boolean): string {
  return focused ? `> ${t(field.label)}` : `  ${t(field.label)}`;
}

function BrokerConfigFieldEditor({
  field,
  draft,
  previous,
  adapter,
  focused,
  onFocus,
  onChange,
  onSubmit,
}: {
  field: BrokerConfigField;
  draft: BrokerProfileDraft;
  previous: BrokerInstanceConfig;
  adapter: BrokerAdapter;
  focused: boolean;
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
      <Box flexDirection="column" onMouseDown={onFocus}>
        <Text fg={focused ? colors.textBright : colors.textDim} attributes={focused ? TextAttributes.BOLD : 0}>
          {brokerFieldLabel(field, focused)}
        </Text>
        <SegmentedControl
          value={value}
          options={(field.options ?? []).map((option) => ({ label: t(option.label), value: option.value }))}
          onChange={(nextValue) => onChange(field.key, nextValue)}
        />
      </Box>
    );
  }

  const Field = field.type === "number" ? NumberField : TextField;
  return (
    <Box onMouseDown={onFocus}>
      <Field
        label={brokerFieldLabel(field, focused)}
        value={value}
        focused={focused}
        width={34}
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
  actions,
  onActiveEditKeyChange,
  onDraftLabelChange,
  onDraftEnabledChange,
  onDraftValueChange,
  onSaveEdit,
  onCancelEdit,
  onStartEdit,
  onConnect,
  onSync,
  onOpenAction,
  onRemove,
}: {
  row: BrokerProfileRow | null;
  accounts: BrokerAccount[];
  editDraft: BrokerProfileDraft | null;
  editFields: BrokerConfigField[];
  activeEditKey: BrokerEditKey;
  busy: string | null;
  message: string | null;
  width: number;
  actions: BrokerProfileAction[];
  onActiveEditKeyChange: (key: BrokerEditKey) => void;
  onDraftLabelChange: (label: string) => void;
  onDraftEnabledChange: (enabled: boolean) => void;
  onDraftValueChange: (key: string, value: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onStartEdit: () => void;
  onConnect: () => void;
  onSync: () => void;
  onOpenAction: (action: BrokerProfileAction) => void;
  onRemove: () => void;
}) {
  if (!row) return <Box flexGrow={1} />;

  const detailStatusMessage = isBrokerErrorMessage(message) ? message : row.message || t("No status message.");
  const editAdapter = row.adapter;

  return (
    <ScrollBox flexGrow={1} scrollY>
      <Box flexDirection="column">
        <Text fg={stateColor(row.state)} attributes={TextAttributes.BOLD}>
          {truncate(`${row.label} · ${row.stateLabel}`, width)}
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
            <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{t("Edit Profile")}</Text>
            <Box onMouseDown={() => onActiveEditKeyChange("label")}>
              <TextField
                label={activeEditKey === "label" ? `> ${t("Profile Label")}` : `  ${t("Profile Label")}`}
                value={editDraft.label}
                focused={activeEditKey === "label"}
                width={34}
                onChange={onDraftLabelChange}
                onSubmit={onSaveEdit}
              />
            </Box>
            <Box flexDirection="column" onMouseDown={() => onActiveEditKeyChange("enabled")}>
              <Text fg={activeEditKey === "enabled" ? colors.textBright : colors.textDim} attributes={activeEditKey === "enabled" ? TextAttributes.BOLD : 0}>
                {activeEditKey === "enabled" ? `> ${t("Enabled")}` : `  ${t("Enabled")}`}
              </Text>
              <SegmentedControl
                value={editDraft.enabled ? "yes" : "no"}
                options={[
                  { label: t("Enabled"), value: "yes" },
                  { label: t("Disabled"), value: "no" },
                ]}
                onChange={(value) => onDraftEnabledChange(value === "yes")}
              />
            </Box>
            {editFields.map((field) => (
              <BrokerConfigFieldEditor
                key={field.key}
                field={field}
                draft={editDraft}
                previous={row.instance}
                adapter={editAdapter}
                focused={activeEditKey === field.key}
                onFocus={() => onActiveEditKeyChange(field.key)}
                onChange={onDraftValueChange}
                onSubmit={onSaveEdit}
              />
            ))}
            <Box flexDirection="row" gap={1}>
              <Button label={t("Save")} variant="primary" onPress={onSaveEdit} disabled={!!busy} />
              <Button label={t("Cancel")} variant="secondary" onPress={onCancelEdit} disabled={!!busy} />
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{t("Accounts")}</Text>
            {accounts.length === 0 ? (
              <Text fg={colors.textDim}>{t("No accounts loaded. Test/connect or sync this profile.")}</Text>
            ) : accounts.map((account) => (
              <Text key={account.accountId} fg={colors.textDim}>
                {truncate(accountDetail(account), width)}
              </Text>
            ))}
            <Box height={1} />
            <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{t("Actions")}</Text>
            <Box flexDirection="row" gap={1}>
              <Button label={t("Edit")} onPress={onStartEdit} disabled={!row.adapter || !!busy} />
              <Button label={t("Test")} onPress={onConnect} disabled={!row.adapter || !!busy} />
              <Button label={t("Sync")} onPress={onSync} disabled={!row.adapter || !!busy} />
            </Box>
            <Box height={1} />
            <Box flexDirection="row" gap={1}>
              {actions.map((action) => (
                <Button
                  key={action.id}
                  label={t(action.label)}
                  onPress={() => onOpenAction(action)}
                  disabled={!!busy || !!action.disabled}
                />
              ))}
              <Button label={t("Disconnect")} variant="danger" onPress={onRemove} disabled={!!busy} />
            </Box>
          </Box>
        )}
      </Box>
    </ScrollBox>
  );
}
