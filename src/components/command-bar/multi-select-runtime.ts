import {
  useCallback,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { PluginRegistry } from "../../plugins/registry";
import {
  commitMultiSelectPickerAction,
  getSelectedMultiSelectPickerOption,
  isMultiSelectPickerRoute,
  moveMultiSelectPickerOption,
  toggleMultiSelectPickerOption,
} from "./multi-select-picker";
import type { CommandBarRoute } from "./workflow/types";

interface UseCommandBarMultiSelectRuntimeOptions {
  currentRoute: CommandBarRoute | null;
  pluginRegistry: PluginRegistry;
  setRouteStack: Dispatch<SetStateAction<CommandBarRoute[]>>;
  updateTopRoute: (updater: (route: CommandBarRoute) => CommandBarRoute) => void;
}

export function useCommandBarMultiSelectRuntime({
  currentRoute,
  pluginRegistry,
  setRouteStack,
  updateTopRoute,
}: UseCommandBarMultiSelectRuntimeOptions): {
  commitMultiSelectPicker: () => void;
  handleMultiSelectMove: (direction: "up" | "down") => void;
  handleMultiSelectSelect: (index: number) => void;
  handleMultiSelectToggle: (optionId: string) => void;
  showCustomMultiSelectPicker: boolean;
} {
  const showCustomMultiSelectPicker = isMultiSelectPickerRoute(currentRoute);

  const handleMultiSelectToggle = useCallback((optionId: string) => {
    if (!isMultiSelectPickerRoute(currentRoute)) return;
    updateTopRoute((route) => {
      if (!isMultiSelectPickerRoute(route)) return route;
      return toggleMultiSelectPickerOption(route, optionId);
    });
  }, [currentRoute, updateTopRoute]);

  const handleMultiSelectMove = useCallback((direction: "up" | "down") => {
    if (!isMultiSelectPickerRoute(currentRoute)) return;
    const selectedItem = getSelectedMultiSelectPickerOption(currentRoute);
    if (!selectedItem) return;

    updateTopRoute((route) => {
      if (!isMultiSelectPickerRoute(route)) return route;
      return moveMultiSelectPickerOption(route, selectedItem.id, direction);
    });
  }, [currentRoute, updateTopRoute]);

  const commitMultiSelectPicker = useCallback(() => {
    if (!isMultiSelectPickerRoute(currentRoute)) return;
    commitMultiSelectPickerAction({
      pluginRegistry,
      route: currentRoute,
      setRouteStack,
      updateTopRoute,
    });
  }, [
    currentRoute,
    pluginRegistry,
    setRouteStack,
    updateTopRoute,
  ]);

  const handleMultiSelectSelect = useCallback((index: number) => {
    updateTopRoute((route) => isMultiSelectPickerRoute(route)
      ? { ...route, selectedIdx: index, hoveredIdx: null }
      : route);
  }, [updateTopRoute]);

  return {
    commitMultiSelectPicker,
    handleMultiSelectMove,
    handleMultiSelectSelect,
    handleMultiSelectToggle,
    showCustomMultiSelectPicker,
  };
}
