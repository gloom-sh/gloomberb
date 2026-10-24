import { useUiCapabilities } from "../ui";
import { type AlertContext, useDialog, useDialogKeyboard } from "../ui/dialog";
import { useEffect, useRef, useState } from "react";
import type { PaneSettingField, PaneSettingRowNote } from "../types/plugin";
import type { PluginRegistry } from "../plugins/registry";
import { isPlainKey } from "../utils/keyboard";
import { openSelectField, type SelectFieldHandle } from "./ui/select-field";
import { listCursorMove, stepListCursor } from "./ui/list-view";
import {
  DesktopPaneSettingsDialogBody,
  DesktopUnavailablePaneSettingsDialog,
} from "./pane-settings-dialog/desktop";
import {
  MultiSelectFieldDialog,
  TextFieldDialog,
  TuiSelectFieldDialog,
} from "./pane-settings-dialog/field-dialogs";
import {
  TuiPaneSettingsDialogBody,
  TuiUnavailablePaneSettingsDialog,
} from "./pane-settings-dialog/tui";
import { isPaneSettingDisabled, isSpaceKey, stepPaneSettingSelect } from "./pane-settings-dialog/value";
import { useRowNotes } from "./ui/row-notes";

const fieldKey = (field: PaneSettingField) => field.key;
/** What an action row shows of its own state: a note on it goes once that moves on (it connected elsewhere, say). */
const actionRowSignature = (field: PaneSettingField) => (
  field.type === "action" ? `${field.actionLabel ?? ""}\u0000${field.description ?? ""}\u0000${field.disabled === true}` : ""
);

interface PaneSettingsDialogContentProps extends AlertContext {
  paneId: string;
  pluginRegistry: PluginRegistry;
  applyFieldValue: (paneId: string, field: PaneSettingField, value: unknown) => Promise<void>;
  /** The setting the cursor starts on, when one was picked in the command bar. */
  initialFieldKey?: string;
}

export function PaneSettingsDialogContent({
  dismiss,
  paneId,
  pluginRegistry,
  applyFieldValue,
  initialFieldKey,
}: PaneSettingsDialogContentProps) {
  const dialog = useDialog();
  const isDesktop = useUiCapabilities().nativePaneChrome === true;
  const descriptor = pluginRegistry.resolvePaneSettings(paneId);
  const fields = descriptor?.settingsDef.fields ?? [];
  // The cursor steps over action rows that cannot run, as the mouse does.
  const rows = fields.map((field) => ({ disabled: isPaneSettingDisabled(field) }));
  const [selectedIndex, setSelectedIndex] = useState(() => {
    const chosen = initialFieldKey ? fields.findIndex((field) => field.key === initialFieldKey) : -1;
    return chosen >= 0 && !rows[chosen]!.disabled ? chosen : Math.max(0, stepListCursor(rows, -1, 1));
  });
  const [, setSettingsRevision] = useState(0);
  const desktopSelectRefs = useRef(new Map<string, SelectFieldHandle>());
  // What an action said on its own row (setRowNote), while the dialog is open.
  const { noteFor, setNote: setRowNote } = useRowNotes<PaneSettingField, PaneSettingRowNote>(fields, { key: fieldKey, signature: actionRowSignature });
  const running = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    if (selectedIndex < fields.length) return;
    const lastEnabled = stepListCursor(rows, fields.length, -1);
    setSelectedIndex(lastEnabled < fields.length ? lastEnabled : Math.max(0, fields.length - 1));
  }, [fields.length, selectedIndex]);

  const applyAndRefresh = async (field: PaneSettingField, value: unknown) => {
    await applyFieldValue(paneId, field, value);
    setSettingsRevision((revision) => revision + 1);
  };

  const setDesktopSelectRef = (fieldKey: string, element: SelectFieldHandle | null) => {
    if (element) desktopSelectRefs.current.set(fieldKey, element);
    else desktopSelectRefs.current.delete(fieldKey);
  };

  const openFieldEditor = async (field: PaneSettingField | undefined) => {
    if (!field || !descriptor) return;
    if (field.type === "action") {
      // A row whose action is still running is not run again.
      if (field.disabled || running.current.has(field.key)) return;
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        dismiss();
      };
      running.current.add(field.key);
      setRowNote(field.key, null);
      try {
        await field.action({
          ...descriptor.context,
          surface: "pane-dialog",
          close,
          openCommandBar: (query) => {
            close();
            queueMicrotask(() => pluginRegistry.openCommandBar(query));
          },
          notify: (notification) => pluginRegistry.notify(notification),
          setRowNote: (note) => {
            // The row is off screen once the dialog has closed, or once its field has left the settings (an
            // account that disconnected and has nothing left to connect). The settings are read again here, as
            // the action may have changed them since the dialog last drew.
            if (closed || !mounted.current) return false;
            const current = pluginRegistry.resolvePaneSettings(paneId)?.settingsDef.fields ?? [];
            if (!current.some((entry) => entry.key === field.key)) return false;
            setRowNote(field.key, note);
            return true;
          },
        });
      } finally {
        running.current.delete(field.key);
      }
      if (!closed && mounted.current) setSettingsRevision((revision) => revision + 1);
      return;
    }
    const currentValue = descriptor.context.settings[field.key];

    if (field.type === "toggle") {
      await applyAndRefresh(field, currentValue !== true);
      return;
    }

    if (field.type === "select") {
      if (isDesktop) {
        openSelectField(desktopSelectRefs.current.get(field.key));
        return;
      }
      await dialog.alert({
        closeOnClickOutside: true,
        content: (ctx: AlertContext) => (
          <TuiSelectFieldDialog
            {...ctx}
            field={field}
            currentValue={currentValue}
            onApply={(value) => applyAndRefresh(field, value)}
          />
        ),
      });
      return;
    }

    if (field.type === "text") {
      await dialog.alert({
        closeOnClickOutside: true,
        content: (ctx: AlertContext) => (
          <TextFieldDialog
            {...ctx}
            field={field}
            currentValue={currentValue}
            onApply={(value) => applyAndRefresh(field, value)}
          />
        ),
      });
      return;
    }

    await dialog.alert({
      closeOnClickOutside: true,
      content: (ctx: AlertContext) => (
        <MultiSelectFieldDialog
          {...ctx}
          field={field}
          currentValue={currentValue}
          onApply={(value) => applyAndRefresh(field, value)}
        />
      ),
    });
  };

  /** Left and right change a toggle or step a select in place, the way a settings list does. */
  const stepField = (field: PaneSettingField | undefined, direction: -1 | 1) => {
    if (!field || !descriptor) return;
    const currentValue = descriptor.context.settings[field.key];
    if (field.type === "toggle") {
      void applyAndRefresh(field, currentValue !== true).catch(() => {});
      return;
    }
    if (field.type !== "select") return;
    const value = stepPaneSettingSelect(field, currentValue, direction);
    if (value !== null) void applyAndRefresh(field, value).catch(() => {});
  };

  useDialogKeyboard((event) => {
    event.stopPropagation();
    const plain = !event.ctrl && !event.meta && !event.alt;
    // The dialog grows to fit its fields, so a page is the whole list.
    const move = listCursorMove(event, fields.length);
    if (move) {
      event.preventDefault();
      setSelectedIndex((index) => move(rows, index));
    } else if (plain && event.name === "tab") {
      event.preventDefault();
      setSelectedIndex((index) => stepListCursor(rows, index, event.shift ? -1 : 1, 1, true));
    } else if (isPlainKey(event, "left", "h", "right", "l")) {
      event.preventDefault();
      stepField(fields[selectedIndex], event.name === "left" || event.name === "h" ? -1 : 1);
    } else if (event.name === "escape") dismiss();
    else if (event.name === "enter" || event.name === "return" || isSpaceKey(event)) {
      event.preventDefault();
      void openFieldEditor(fields[selectedIndex]).catch(() => {});
    }
  });

  if (!descriptor) {
    return isDesktop
      ? <DesktopUnavailablePaneSettingsDialog dismiss={dismiss} />
      : <TuiUnavailablePaneSettingsDialog />;
  }

  const title = descriptor.settingsDef.title ?? `${descriptor.paneDef.name} Settings`;

  return isDesktop ? (
    <DesktopPaneSettingsDialogBody
      title={title}
      dismiss={dismiss}
      fields={fields}
      selectedIndex={selectedIndex}
      settings={descriptor.context.settings}
      noteFor={noteFor}
      onHover={(_field, index) => setSelectedIndex(index)}
      onSelectRef={setDesktopSelectRef}
      onEdit={(field, index) => {
        setSelectedIndex(index);
        void openFieldEditor(field).catch(() => {});
      }}
      onApply={(field, value, index) => {
        setSelectedIndex(index);
        void applyAndRefresh(field, value).catch(() => {});
      }}
    />
  ) : (
    <TuiPaneSettingsDialogBody
      title={title}
      fields={fields}
      selectedIndex={selectedIndex}
      settings={descriptor.context.settings}
      noteFor={noteFor}
      onSelect={setSelectedIndex}
      onActivate={(field) => {
        void openFieldEditor(field).catch(() => {});
      }}
    />
  );
}
