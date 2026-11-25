import { useEffect, useRef, type Ref } from "react";
import { Box, ScrollBox, Text, TextAttributes, useNativeRenderer, useUiCapabilities, type BoxRenderable, type ScrollBoxRenderable } from "../../../ui";
import { Button, Checkbox, FieldLabel, NumberField, SectionHeading, SegmentedControl, TextField, useFieldRing } from "../../../components";
import { afterLayout, revealInScrollBox } from "../../../components/ui/reveal-in-scroll-box";
import type { AccountInclusion } from "../../../brokers/account-choice";
import {
  PRESERVED_PASSWORD_HINT,
  type BrokerProfileDraft,
} from "../../../brokers/profile-form";
import { colors } from "../../../theme/colors";
import type { BrokerAdapter, BrokerConfigField } from "../../../types/broker";
import type { BrokerInstanceConfig } from "../../../types/config";
import type { BrokerAccount } from "../../../types/trading";
import { formatRelativeAge } from "../../../utils/datetime-format";
import { clipToDisplayWidth, formatCurrency } from "../../../utils/format";
import { ClippedText } from "../../../components/ui/display";
import { t, tf } from "../../../i18n";
import type { BrokerProfileRow } from "./model";
import type { BrokerRowActivity } from "./pane-actions";
import { signInEndNote } from "./sign-in-end";
import { brokerRowStatus } from "./table";

export type BrokerEditKey = "label" | "enabled" | "localOnly" | string;

/** An account's checkbox in the edit form, one field of its ring each. */
const ACCOUNT_EDIT_KEY = "account:";

export function accountEditKey(accountId: string): BrokerEditKey {
  return `${ACCOUNT_EDIT_KEY}${accountId}`;
}

/** The account an edit key ticks, or null for any other field. */
export function editKeyAccountId(key: BrokerEditKey): string | null {
  return key.startsWith(ACCOUNT_EDIT_KEY) ? key.slice(ACCOUNT_EDIT_KEY.length) : null;
}

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

/** An account by the name its broker gives it, as its portfolio is named; its id when it has none. */
function accountDetail(account: BrokerAccount): string {
  const parts = [
    account.name?.trim() || account.accountId,
    account.netLiquidation != null ? tf("{value} net liq", { value: formatCurrency(account.netLiquidation, account.currency || "") }) : null,
    account.buyingPower != null ? tf("{value} buying power", { value: formatCurrency(account.buyingPower, account.currency || "") }) : null,
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
  accountChoices = [],
  activeKey,
  busy,
  width,
  rowWidth = width,
  scope,
  paneFocused,
  submitLabel,
  error,
  actionsRef,
  rowRef,
  onActiveKeyChange,
  onLabelChange,
  onEnabledChange,
  onLocalOnlyChange,
  onAccountToggle,
  onValueChange,
  onSubmit,
  onCancel,
}: {
  adapter: BrokerAdapter;
  draft: BrokerProfileDraft;
  fields: BrokerConfigField[];
  previous: BrokerInstanceConfig | null;
  /** Editing only: the profile's accounts to keep or leave out, for a profile with several. */
  accountChoices?: readonly AccountInclusion[];
  activeKey: BrokerEditKey;
  busy: string | null;
  /** Columns a text field may take. */
  width: number;
  /** Columns a checkbox row may take: the detail's. */
  rowWidth?: number;
  /** The form's shortcut scope, shared with the pane's field ring. */
  scope: string;
  /** The form's fields take keys only while the pane has the keyboard. */
  paneFocused: boolean;
  submitLabel: string;
  /** What stopped the last submit, said beside the buttons. */
  error?: string | null;
  /** The error and the buttons, for the detail to scroll into view when the error shows. */
  actionsRef?: Ref<BoxRenderable>;
  /** Each field's outer box, for the form's field ring to scroll into view. */
  rowRef: (key: BrokerEditKey) => RowRef;
  onActiveKeyChange: (key: BrokerEditKey) => void;
  onLabelChange: (label: string) => void;
  /** Editing only: a new profile starts enabled. */
  onEnabledChange?: (enabled: boolean) => void;
  onLocalOnlyChange: (localOnly: boolean) => void;
  /** Ticks or unticks an account of `accountChoices`. */
  onAccountToggle?: (accountId: string) => void;
  onValueChange: (key: string, value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const excluded = new Set(draft.excludedAccountIds);
  const desktop = useUiCapabilities().nativePaneChrome === true;
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
      {accountChoices.length > 0 && onAccountToggle ? (
        <Box flexDirection="column">
          <FieldLabel label={t("Accounts")} />
          {accountChoices.map((choice) => {
            const key = accountEditKey(choice.accountId);
            return (
              <Box key={key} ref={rowRef(key)} onMouseDown={() => onActiveKeyChange(key)}>
                <Checkbox
                  label={choice.name}
                  // A terminal row keeps to one line: "> [x] " and the name, cut to fit.
                  displayLabel={desktop ? undefined : clipToDisplayWidth(choice.name, Math.max(1, rowWidth - 6))}
                  checked={!excluded.has(choice.accountId)}
                  active={paneFocused && activeKey === key}
                  width={rowWidth}
                  onChange={() => {
                    onActiveKeyChange(key);
                    onAccountToggle(choice.accountId);
                  }}
                />
              </Box>
            );
          })}
        </Box>
      ) : null}
      <Box ref={rowRef("localOnly")} flexDirection="column" onMouseDown={() => onActiveKeyChange("localOnly")}>
        <FieldLabel label={t("Account data")} active={activeKey === "localOnly"} />
        <SegmentedControl
          value={draft.localOnly ? "local" : "sync"}
          focused={paneFocused && activeKey === "localOnly"}
          options={[
            { label: t("Sync with Gloom Cloud"), value: "sync" },
            { label: t("Keep on this device"), value: "local" },
          ]}
          onChange={(value) => onLocalOnlyChange(value === "local")}
          allowEditable
          shortcutScope={scope}
        />
        {draft.localOnly ? (
          <Text fg={colors.textMuted} wrapText>
            {t("Daily roundups, the weekly brief, position alerts, the mobile app and Ask Gloom will go without this account.")}
          </Text>
        ) : null}
      </Box>
      <Box ref={actionsRef} flexDirection="column">
        {error ? <Text fg={colors.negative} width={width} wrapText>{error}</Text> : null}
        <Box flexDirection="row" gap={1}>
          <Button label={submitLabel} shortcut="Enter" variant="primary" onPress={onSubmit} disabled={!!busy} />
          <Button label={t("Cancel")} shortcut="Esc" variant="secondary" onPress={onCancel} disabled={!!busy} />
        </Box>
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
  accountChoices,
  editDraft,
  editFields,
  activeEditKey,
  editKeys,
  busy,
  activity,
  editError,
  width,
  editScope,
  paneFocused,
  onActiveEditKeyChange,
  onDraftLabelChange,
  onDraftEnabledChange,
  onDraftLocalOnlyChange,
  onDraftAccountToggle,
  onDraftValueChange,
  onSaveEdit,
  onCancelEdit,
}: {
  row: BrokerProfileRow | null;
  accounts: BrokerAccount[];
  /** The profile's accounts to keep or leave out; none for a profile with one. */
  accountChoices: readonly AccountInclusion[];
  editDraft: BrokerProfileDraft | null;
  editFields: BrokerConfigField[];
  activeEditKey: BrokerEditKey;
  /** The edit form's fields in Tab order. */
  editKeys: readonly BrokerEditKey[];
  busy: string | null;
  /** The pane's action running on this profile, and what the last one came to. */
  activity: BrokerRowActivity;
  /** What stops the edit form from saving. */
  editError: string | null;
  width: number;
  /** The edit form's shortcut scope, shared with the pane's field ring. */
  editScope: string;
  /** The form's fields take keys only while the pane has the keyboard. */
  paneFocused: boolean;
  onActiveEditKeyChange: (key: BrokerEditKey) => void;
  onDraftLabelChange: (label: string) => void;
  onDraftEnabledChange: (enabled: boolean) => void;
  onDraftLocalOnlyChange: (localOnly: boolean) => void;
  onDraftAccountToggle: (accountId: string) => void;
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
  // Enter saves from any field, so what stopped the save can be below the
  // fold; bring it and the buttons into view.
  const actionsRef = useRef<BoxRenderable | null>(null);
  const desktop = useUiCapabilities().nativePaneChrome === true;
  const nativeRenderer = useNativeRenderer();
  useEffect(() => {
    if (!editError) return;
    const reveal = () => revealInScrollBox(scrollRef.current, actionsRef.current);
    if (desktop) return afterLayout(reveal);
    // The terminal lays the error line out only when it draws a frame, which
    // can come after a 0 ms timer: measured before it, the buttons are one row
    // short and the error pushes Save back below the fold.
    const onFrame = () => {
      nativeRenderer.off("frame", onFrame);
      reveal();
    };
    nativeRenderer.on("frame", onFrame);
    nativeRenderer.requestRender();
    return () => nativeRenderer.off("frame", onFrame);
  }, [desktop, editError, nativeRenderer]);

  if (!row) return <Box flexGrow={1} />;

  // The row's STATUS, and in full what the last action on the profile came to,
  // which outranks the profile's own status message until it is news no more.
  // The sign-in's end has a line of its own below.
  const status = brokerRowStatus({ ...row, signInEnd: null }, activity);
  const note = activity.note ?? null;
  const detailStatusMessage = note?.text ?? (row.message || t("No status message."));
  const statusMessageColor = note
    ? note.tone === "error" ? colors.negative : colors.textDim
    : row.state === "error" ? colors.negative
      : row.state === "sign-in" || row.state === "disabled" ? colors.warning
        : colors.textDim;
  const editAdapter = row.adapter;
  const leftOut = accountChoices.filter((choice) => !choice.included).length;

  return (
    <ScrollBox ref={scrollRef} flexGrow={1} scrollY>
      <Box flexDirection="column" paddingX={1}>
        {/* The stack title already names the profile; the body starts with its state. */}
        <ClippedText fg={status.color} attributes={TextAttributes.BOLD} text={status.text} width={width} />
        <ClippedText fg={colors.textDim} text={`${row.brokerName} · ${row.mode} · ${row.id}`} width={width} />
        <Text fg={statusMessageColor} width={width} wrapText>
          {detailStatusMessage}
        </Text>
        {row.signInEnd !== null && (
          <Text fg={row.signInEnd.soon ? colors.warning : colors.textDim} width={width} wrapText>
            {signInEndNote(row.signInEnd.endsAt)}
          </Text>
        )}
        <Text fg={colors.textMuted}>{tf("Last sync {time}", { time: formatRelativeAge(row.lastSyncedAt) })}</Text>
        {row.instance.localOnly ? <Text fg={colors.textMuted}>{t("Account data stays on this device, out of Gloom Cloud")}</Text> : null}
        <Text fg={colors.textMuted}>{tf("Status updated {time}", { time: formatRelativeAge(row.updatedAt) })}</Text>
        <Box height={1} />

        {/* Keyed apart: the terminal keeps a reused box's gap, so the accounts would stay spaced like the form. */}
        {editDraft && editAdapter ? (
          <Box key="edit" flexDirection="column" gap={1}>
            <SectionHeading title="Edit Profile" />
            <BrokerProfileForm
              adapter={editAdapter}
              draft={editDraft}
              fields={editFields}
              previous={row.instance}
              accountChoices={accountChoices}
              activeKey={activeEditKey}
              busy={busy}
              width={profileFieldWidth(width)}
              rowWidth={width}
              scope={editScope}
              paneFocused={paneFocused}
              submitLabel={t("Save")}
              error={editError}
              actionsRef={actionsRef}
              rowRef={rowRef}
              onActiveKeyChange={onActiveEditKeyChange}
              onLabelChange={onDraftLabelChange}
              onEnabledChange={onDraftEnabledChange}
              onLocalOnlyChange={onDraftLocalOnlyChange}
              onAccountToggle={onDraftAccountToggle}
              onValueChange={onDraftValueChange}
              onSubmit={onSaveEdit}
              onCancel={onCancelEdit}
            />
          </Box>
        ) : (
          // Edit, test, sync, open and disconnect are the footer's e, c, s, o and d.
          <Box key="accounts" flexDirection="column">
            <SectionHeading title="Accounts" />
            {accounts.length === 0 ? (
              <Text fg={colors.textDim}>{t("No accounts loaded. Test/connect or sync this profile.")}</Text>
            ) : accounts.map((account) => (
              <ClippedText key={account.accountId} fg={colors.textDim} text={accountDetail(account)} width={width} />
            ))}
            {leftOut > 0 ? (
              <Text fg={colors.textMuted}>
                {leftOut === 1 ? t("1 account left out of Gloom") : tf("{count} accounts left out of Gloom", { count: leftOut })}
              </Text>
            ) : null}
          </Box>
        )}
      </Box>
    </ScrollBox>
  );
}
