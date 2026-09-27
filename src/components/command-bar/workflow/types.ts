
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
    | "broker-type";
  title: string;
  query: string;
  selectedIdx: number;
  hoveredIdx: number | null;
  options: CommandBarPickerOption[];
  payload?: Record<string, unknown>;
}

/**
 * A form: fields, values and what submitting does. It opens in the form modal
 * (`components/form-modal`), never as a screen of the bar, so it is not a
 * `CommandBarRoute`. Confirms open there too (`openConfirmModal`).
 */
export interface CommandBarWorkflowRoute {
  kind: "workflow";
  workflowId: string;
  title: string;
  subtitle?: string;
  description?: string[];
  fields: CommandBarWorkflowField[];
  values: Record<string, CommandBarFieldValue>;
  activeFieldId: string | null;
  submitLabel: string;
  /** Replaces `submitLabel` while the values match, e.g. a choice with nothing to fill in. */
  submitLabels?: Array<{ dependsOn: CommandBarFieldDependency[]; label: string }>;
  cancelLabel?: string;
  pendingLabel?: string;
  successLabel?: string;
  pending: boolean;
  error: string | null;
  successBehavior?: "close" | "back";
  payload: {
    kind: "builtin" | "plugin-command" | "pane-template";
    actionId: string;
  };
  payloadMeta?: Record<string, unknown>;
}

export type CommandBarRoute =
  | CommandBarModeRoute
  | CommandBarPickerRoute;
