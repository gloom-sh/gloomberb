
export interface CommandBarMainSnapshot {
  query: string;
  selectedIdx: number;
}

export interface CommandBarFieldOption {
  label: string;
  value: string;
  description?: string;
}

interface CommandBarFieldDependency {
  key: string;
  value: string;
}

interface CommandBarFieldBase {
  id: string;
  label: string;
  description?: string;
  placeholder?: string;
  required?: boolean;
  dependsOn?: CommandBarFieldDependency[];
  clearOnChange?: string[];
}

export type CommandBarWorkflowField =
  | (CommandBarFieldBase & { type: "text" | "password" | "number" | "textarea" })
  | (CommandBarFieldBase & { type: "toggle" })
  | (CommandBarFieldBase & { type: "select"; options: CommandBarFieldOption[] })
  | (CommandBarFieldBase & { type: "multi-select" | "ordered-multi-select"; options: CommandBarFieldOption[] });

export type CommandBarFieldValue = string | boolean | string[];

interface CommandBarRouteBase {
  restoreMain?: CommandBarMainSnapshot;
}

interface CommandBarModeRoute extends CommandBarRouteBase {
  kind: "mode";
  screen: "ticker-search" | "layout";
  query: string;
  selectedIdx: number;
  hoveredIdx: number | null;
  payload?: Record<string, unknown>;
}

export interface CommandBarPickerOption {
  id: string;
  label: string;
  detail?: string;
  description?: string;
  disabled?: boolean;
}

export interface CommandBarPickerRoute extends CommandBarRouteBase {
  kind: "picker";
  pickerId:
    | "layout-swap"
    | "delete-watchlist"
    | "delete-portfolio"
    | "disconnect-broker"
    | "collection-target"
    | "broker-type"
    | "field-select"
    | "field-multi-select";
  title: string;
  query: string;
  selectedIdx: number;
  hoveredIdx: number | null;
  options: CommandBarPickerOption[];
  payload?: Record<string, unknown>;
}

export interface CommandBarConfirmRoute extends CommandBarRouteBase {
  kind: "confirm";
  confirmId: string;
  title: string;
  body: string[];
  confirmLabel: string;
  cancelLabel?: string;
  tone: "default" | "danger";
  onConfirm: () => void | Promise<void>;
  pending: boolean;
  error: string | null;
  successBehavior?: "close" | "back" | "stay";
}

export interface CommandBarWorkflowRoute extends CommandBarRouteBase {
  kind: "workflow";
  workflowId: string;
  title: string;
  subtitle?: string;
  description?: string[];
  fields: CommandBarWorkflowField[];
  values: Record<string, CommandBarFieldValue>;
  activeFieldId: string | null;
  submitLabel: string;
  cancelLabel?: string;
  pendingLabel?: string;
  successLabel?: string;
  pending: boolean;
  error: string | null;
  successBehavior?: "close" | "back";
  payload: {
    kind: "builtin" | "plugin-command" | "pane-template" | "pane-setting";
    actionId: string;
  };
  payloadMeta?: Record<string, unknown>;
}

interface CommandBarPaneSettingsRoute extends CommandBarRouteBase {
  kind: "pane-settings";
  paneId: string;
  query: string;
  selectedIdx: number;
  hoveredIdx: number | null;
  error: string | null;
  pendingFieldKey: string | null;
}

export type CommandBarRoute =
  | CommandBarModeRoute
  | CommandBarPickerRoute
  | CommandBarConfirmRoute
  | CommandBarWorkflowRoute
  | CommandBarPaneSettingsRoute;
