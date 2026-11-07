import type { AppConfig, LayoutConfig, PaneInstanceConfig } from "./config";
import type { AppNotificationRequest } from "./plugin-notifications";

export interface PaneSettingsContext {
  config: AppConfig;
  layout: LayoutConfig;
  paneId: string;
  paneType: string;
  pane: PaneInstanceConfig;
  settings: Record<string, unknown>;
  paneState: Record<string, unknown>;
  activeTicker: string | null;
  activeCollectionId: string | null;
}

export interface PaneSettingOption {
  value: string;
  label: string;
  description?: string;
}

interface PaneSettingFieldBase {
  key: string;
  label: string;
  description?: string;
  storage?: "pane" | "plugin";
  /** Keys in the same storage scope that should be reset when this value changes. */
  clearOnChange?: string[];
}

interface PaneSettingToggleField extends PaneSettingFieldBase {
  type: "toggle";
}

export interface PaneSettingTextField extends PaneSettingFieldBase {
  type: "text";
  placeholder?: string;
}

interface PaneSettingSelectField extends PaneSettingFieldBase {
  type: "select";
  options: PaneSettingOption[];
}

interface PaneSettingMultiSelectField extends PaneSettingFieldBase {
  type: "multi-select";
  options: PaneSettingOption[];
  /** A long list: a filter box, each description beside its label. */
  searchable?: boolean;
}

interface PaneSettingOrderedMultiSelectField extends PaneSettingFieldBase {
  type: "ordered-multi-select";
  options: PaneSettingOption[];
  /** A long list: a filter box, each description beside its label and each selection's position. */
  searchable?: boolean;
}

/** What an action row says of its own action (docs/pane-conventions.md, "Row messages"). */
export interface PaneSettingRowNote {
  /** A short state, where the row's action label is: `Connecting…`, `Sign-in failed`. */
  status: string;
  /** The full reason or the next step, in place of the row's description. */
  text?: string;
  tone: "warning" | "negative";
}

export interface PaneSettingActionContext extends PaneSettingsContext {
  surface: "pane-dialog" | "command-bar";
  close(): void;
  openCommandBar(query?: string): void;
  notify(notification: AppNotificationRequest): void;
  /**
   * Says on the row the action runs from what it is doing or what stopped it,
   * or clears that with null. A success the row's own description and label
   * show once they change needs no note. False once the row is off screen
   * (the dialog closed, or the action removed its own field): say it with
   * `notify` then, as a row that has left a list is a toast. Older hosts do
   * not pass it.
   */
  setRowNote?(note: PaneSettingRowNote | null): boolean;
}

export type PaneSettingActionHandler = (
  context: PaneSettingActionContext,
) => void | Promise<void>;

export type PaneSettingActionField = Omit<PaneSettingFieldBase, "storage" | "clearOnChange"> & {
  type: "action";
  actionId: string;
  actionLabel?: string;
  disabled?: boolean;
  action: PaneSettingActionHandler;
};

export type PaneSettingField =
  | PaneSettingToggleField
  | PaneSettingTextField
  | PaneSettingSelectField
  | PaneSettingMultiSelectField
  | PaneSettingOrderedMultiSelectField
  | PaneSettingActionField;

export interface PaneSettingsDef {
  title?: string;
  values?: Record<string, unknown>;
  fields: PaneSettingField[];
  applyValue?: (
    settings: Record<string, unknown>,
    field: PaneSettingField,
    value: unknown,
    context: PaneSettingsContext,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
}
