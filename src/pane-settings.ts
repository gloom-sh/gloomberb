import {
  cloneLayout,
  clonePaneSettings,
  findPaneInstance,
  type LayoutConfig,
  type PaneInstanceConfig,
} from "./types/config";

export function getPaneSettings(instance: PaneInstanceConfig | null | undefined): Record<string, unknown> {
  return clonePaneSettings(instance?.settings) ?? {};
}

export function getPaneSettingValue<T>(
  instance: PaneInstanceConfig | null | undefined,
  key: string,
  fallback: T,
): T {
  return (instance?.settings?.[key] as T | undefined) ?? fallback;
}

export function updatePaneInstance(
  layout: LayoutConfig,
  paneId: string,
  updater: (instance: PaneInstanceConfig) => PaneInstanceConfig,
): LayoutConfig {
  const existing = findPaneInstance(layout, paneId);
  if (!existing) return layout;

  const nextLayout = cloneLayout(layout);
  const index = nextLayout.instances.findIndex((instance) => instance.instanceId === paneId);
  if (index < 0) return layout;

  nextLayout.instances[index] = updater(nextLayout.instances[index]!);
  return nextLayout;
}

export function setPaneSettings(
  layout: LayoutConfig,
  paneId: string,
  settings: Record<string, unknown> | undefined,
): LayoutConfig {
  return updatePaneInstance(layout, paneId, (instance) => ({
    ...instance,
    settings: clonePaneSettings(settings),
  }));
}

export function setPaneSetting(
  layout: LayoutConfig,
  paneId: string,
  key: string,
  value: unknown,
): LayoutConfig {
  const current = findPaneInstance(layout, paneId);
  if (!current || Object.is(current.settings?.[key], value)) return layout;
  return setPaneSettings(layout, paneId, {
    ...(current.settings ?? {}),
    [key]: value,
  });
}

export function deletePaneSetting(
  layout: LayoutConfig,
  paneId: string,
  key: string,
): LayoutConfig {
  const current = findPaneInstance(layout, paneId);
  if (!current?.settings || !(key in current.settings)) return layout;

  const nextSettings = { ...current.settings };
  delete nextSettings[key];
  return setPaneSettings(layout, paneId, Object.keys(nextSettings).length > 0 ? nextSettings : undefined);
}
