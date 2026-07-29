import { useUiHost } from "../ui";
import { type AlertContext, useDialog, useDialogKeyboard } from "../ui/dialog";
import { useEffect, useRef, useState } from "react";
import type { PaneSettingField } from "../types/plugin";
import type { PluginRegistry } from "../plugins/registry";
import { isPlainKey } from "../utils/keyboard";
import { openNativeSelect, type NativeSelectElement } from "./ui/native-select";
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
import { isSpaceKey } from "./pane-settings-dialog/value";

interface PaneSettingsDialogContentProps extends AlertContext {
  paneId: string;
  pluginRegistry: PluginRegistry;
  applyFieldValue: (paneId: string, field: PaneSettingField, value: unknown) => Promise<void>;
}

export function PaneSettingsDialogContent({
  dismiss,
  paneId,
  pluginRegistry,
  applyFieldValue,
}: PaneSettingsDialogContentProps) {
  const dialog = useDialog();
  const isDesktop = useUiHost().kind === "desktop-web";
  const descriptor = pluginRegistry.resolvePaneSettings(paneId);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [hoveredFieldKey, setHoveredFieldKey] = useState<string | null>(null);
  const [, setSettingsRevision] = useState(0);
  const desktopSelectRefs = useRef(new Map<string, NativeSelectElement>());

  const fields = descriptor?.settingsDef.fields ?? [];

  useEffect(() => {
    if (selectedIndex >= fields.length) {
      setSelectedIndex(Math.max(0, fields.length - 1));
    }
  }, [fields.length, selectedIndex]);

  const applyAndRefresh = async (field: PaneSettingField, value: unknown) => {
    await applyFieldValue(paneId, field, value);
    setSettingsRevision((revision) => revision + 1);
  };

  const setDesktopSelectRef = (fieldKey: string, element: NativeSelectElement | null) => {
    if (element) desktopSelectRefs.current.set(fieldKey, element);
    else desktopSelectRefs.current.delete(fieldKey);
  };

  const openFieldEditor = async (field: PaneSettingField | undefined) => {
    if (!field || !descriptor) return;
    if (field.type === "action") {
      if (field.disabled) return;
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        dismiss();
      };
      await field.action({
        ...descriptor.context,
        surface: "pane-dialog",
        close,
        openCommandBar: (query) => {
          close();
          queueMicrotask(() => pluginRegistry.openCommandBar(query));
        },
        notify: (notification) => pluginRegistry.notify(notification),
      });
      if (!closed) setSettingsRevision((revision) => revision + 1);
      return;
    }
    const currentValue = descriptor.context.settings[field.key];

    if (field.type === "toggle") {
      await applyAndRefresh(field, currentValue !== true);
      return;
    }

    if (field.type === "select") {
      if (isDesktop) {
        openNativeSelect(desktopSelectRefs.current.get(field.key));
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

  useDialogKeyboard((event) => {
    event.stopPropagation();
    if (isPlainKey(event, "up", "k")) setSelectedIndex((index) => Math.max(0, index - 1));
    else if (isPlainKey(event, "down", "j")) setSelectedIndex((index) => Math.min(fields.length - 1, index + 1));
    else if (event.name === "escape") dismiss();
    else if (event.name === "enter" || event.name === "return" || isSpaceKey(event)) {
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
      hoveredFieldKey={hoveredFieldKey}
      settings={descriptor.context.settings}
      onHover={(field, index) => {
        setSelectedIndex(index);
        setHoveredFieldKey(field.key);
      }}
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
      onSelect={setSelectedIndex}
      onActivate={(field) => {
        void openFieldEditor(field).catch(() => {});
      }}
    />
  );
}
