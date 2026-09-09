import type { Dispatch, SetStateAction } from "react";
import { t } from "../../i18n";
import type { PluginRegistry } from "../../plugins/registry";
import type { PaneSettingField } from "../../types/plugin";
import { Box } from "../../ui";
import { fuzzyFilter } from "../../utils/fuzzy-search";
import { ToggleList } from "../toggle-list";
import { Button } from "../ui";
import {
  moveMultiSelectValue,
  toggleMultiSelectValue,
  toggleOrderedMultiSelectValue,
  type MultiSelectOption,
} from "../ui/multi-select";
import { coerceFieldValues } from "./helpers";
import { useCommandBarPalette } from "./panel/palette";
import type {
  CommandBarFieldValue,
  CommandBarPickerOption,
  CommandBarPickerRoute,
  CommandBarRoute,
} from "./workflow/types";

export type CommandBarMultiSelectPickerRoute = CommandBarPickerRoute & {
  pickerId: "field-multi-select";
};

export function isMultiSelectPickerRoute(route: CommandBarRoute | null): route is CommandBarMultiSelectPickerRoute {
  return route?.kind === "picker" && route.pickerId === "field-multi-select";
}

export function toggleMultiSelectPickerOption(
  route: CommandBarMultiSelectPickerRoute,
  optionId: string,
): CommandBarMultiSelectPickerRoute {
  const selectedValues = getMultiSelectPickerSelectedValues(route);
  const options = toMultiSelectOptions(route.options);
  const nextSelectedValues = route.payload?.fieldType === "ordered-multi-select"
    ? toggleOrderedMultiSelectValue(options, selectedValues, optionId)
    : toggleMultiSelectValue(options, selectedValues, optionId);
  const nextRoute = {
    ...route,
    payload: {
      ...route.payload,
      selectedValues: nextSelectedValues,
    },
  };
  const nextOptions = getVisibleMultiSelectPickerOptions(nextRoute);
  const nextSelectedIdx = nextOptions.findIndex((option) => option.id === optionId);
  return {
    ...nextRoute,
    selectedIdx: nextSelectedIdx >= 0 ? nextSelectedIdx : 0,
  };
}

export function getSelectedMultiSelectPickerOption(route: CommandBarMultiSelectPickerRoute) {
  return getVisibleMultiSelectPickerOptions(route)[route.selectedIdx] ?? null;
}

export function getVisibleMultiSelectPickerOptions(
  route: CommandBarPickerRoute,
): CommandBarPickerOption[] {
  if (route.pickerId !== "field-multi-select") {
    return route.query
      ? fuzzyFilter(route.options, route.query, (option) => `${option.label} ${t(option.label)} ${option.detail || ""} ${option.description || ""}`)
      : route.options;
  }

  const selectedValues = coerceFieldValues(route.payload?.selectedValues as CommandBarFieldValue | undefined);
  const optionById = new Map(route.options.map((option) => [option.id, option]));
  const knownSelectedValues = selectedValues.filter((value) => optionById.has(value));
  const filteredOptions = route.query
    ? fuzzyFilter(route.options, route.query, (option) => `${option.label} ${t(option.label)} ${option.detail || ""} ${option.description || ""}`)
    : route.options;

  return filteredOptions.map((option) => {
    const order = knownSelectedValues.indexOf(option.id);
    const orderDescription = String(route.payload?.fieldType ?? "") === "ordered-multi-select" && order >= 0
      ? `Order ${order + 1} of ${knownSelectedValues.length}.`
      : "";
    const description = [option.description || option.detail, orderDescription]
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      .join(" ");
    return {
      ...option,
      detail: description,
      description,
    };
  });
}

export function moveMultiSelectPickerOption(
  route: CommandBarMultiSelectPickerRoute,
  optionId: string,
  direction: "up" | "down",
): CommandBarMultiSelectPickerRoute {
  const fieldType = String(route.payload?.fieldType ?? "");
  if (fieldType !== "ordered-multi-select") return route;
  const selectedValues = getMultiSelectPickerSelectedValues(route);
  const nextSelectedValues = moveMultiSelectValue(
    toMultiSelectOptions(route.options),
    selectedValues,
    optionId,
    direction,
  );
  const nextRoute = {
    ...route,
    payload: {
      ...route.payload,
      selectedValues: nextSelectedValues,
    },
  };
  const nextOptions = getVisibleMultiSelectPickerOptions(nextRoute);
  const nextSelectedIdx = nextOptions.findIndex((option) => option.id === optionId);
  return {
    ...nextRoute,
    selectedIdx: nextSelectedIdx >= 0 ? nextSelectedIdx : route.selectedIdx,
  };
}

export function commitMultiSelectPickerAction({
  pluginRegistry,
  route,
  setRouteStack,
  updateTopRoute,
  updateWorkflowValue,
}: {
  pluginRegistry: PluginRegistry;
  route: CommandBarMultiSelectPickerRoute;
  setRouteStack: Dispatch<SetStateAction<CommandBarRoute[]>>;
  updateTopRoute: (updater: (route: CommandBarRoute) => CommandBarRoute) => void;
  updateWorkflowValue: (fieldId: string, value: CommandBarFieldValue) => void;
}): void {
  const selectedValues = getMultiSelectPickerSelectedValues(route);
  const parentKind = String(route.payload?.parentKind ?? "");
  if (parentKind === "workflow") {
    updateWorkflowValue(String(route.payload?.fieldId ?? ""), selectedValues);
    setRouteStack((current) => current.slice(0, -1));
    return;
  }

  if (parentKind === "pane-settings") {
    const paneId = String(route.payload?.paneId ?? "");
    const field = route.payload?.field as PaneSettingField | undefined;
    if (!paneId || !field) return;
    void pluginRegistry.applyPaneSettingValueFn(paneId, field, selectedValues)
      .then(() => {
        setRouteStack((current) => current.slice(0, -1));
      })
      .catch((error) => {
        updateTopRoute((route) => route.kind === "pane-settings"
          ? { ...route, error: error instanceof Error ? error.message : "Could not apply that setting." }
          : route);
      });
  }
}

export function CommandBarMultiSelectBody({
  bodyHeight,
  contentPadding,
  nativePaneChrome,
  onCommit,
  onSelect,
  onToggle,
  route,
}: {
  bodyHeight: number;
  contentPadding: number;
  nativePaneChrome: boolean;
  onCommit: () => void;
  onSelect: (index: number) => void;
  onToggle: (id: string) => void;
  route: CommandBarMultiSelectPickerRoute;
}) {
  const palette = useCommandBarPalette(nativePaneChrome);
  const selectedValues = getMultiSelectPickerSelectedValues(route);
  const options = getVisibleMultiSelectPickerOptions(route);
  const items = options.map((option) => ({
    id: option.id,
    label: t(option.label),
    enabled: selectedValues.includes(option.id),
    description: (option.description || option.detail) ? t(option.description || option.detail || "") : undefined,
  }));
  const selectedIdx = items.length === 0
    ? 0
    : Math.max(0, Math.min(route.selectedIdx, items.length - 1));

  return (
    <Box flexDirection="column" height={bodyHeight} paddingX={contentPadding}>
      <ToggleList
        items={items}
        selectedIdx={selectedIdx}
        flexGrow={1}
        scrollable
        showSelectedDescription={false}
        onSelect={onSelect}
        onToggle={onToggle}
        bgColor={nativePaneChrome ? palette.panelBg : palette.bg}
        remoteLabel={route.title}
        remoteScope="command-bar"
        remoteMetadata={{
          surface: "multi-select-picker",
          routeKind: route.kind,
          pickerId: route.pickerId,
        }}
      />
      <Box flexDirection="row" gap={1}>
        <Button label={t("Done")} variant="primary" onPress={onCommit} />
      </Box>
    </Box>
  );
}

function getMultiSelectPickerSelectedValues(route: CommandBarMultiSelectPickerRoute): string[] {
  return coerceFieldValues(route.payload?.selectedValues as CommandBarFieldValue | undefined);
}

function toMultiSelectOptions(options: CommandBarPickerOption[]): MultiSelectOption[] {
  return options.map((option) => ({
    value: option.id,
    label: option.label,
    description: option.description,
    disabled: option.disabled,
  }));
}
