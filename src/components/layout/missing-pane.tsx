import { useCallback, useState } from "react";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/status";
import { canInstallPlugins } from "../../plugins/current-target";
import { getPluginManager } from "../../plugins/builtin/plugin-marketplace/store";
import type { PaneDef, PaneProps } from "../../types/plugin";
import { Box } from "../../ui";
import { useAppSelector } from "../../state/app/context";
import type { LayoutRequirement } from "../../layout-marketplace/cloud";

/**
 * What a pane from a plugin you do not have needs to be installable: the
 * `requires` list that came with the team layout. Kept per app so pane
 * placeholders can find it without threading it through the layout.
 */
const layoutRequirements = new Map<string, LayoutRequirement[]>();

export function rememberLayoutRequirements(layoutId: string, requires: LayoutRequirement[]): void {
  layoutRequirements.set(layoutId, requires);
}

function requirementFor(paneId: string, layoutIds: readonly string[]): LayoutRequirement | null {
  // Pane ids are `<plugin>:<name>` or `<plugin>-<name>` by convention; match
  // the plugin whose id prefixes the pane id.
  for (const layoutId of layoutIds) {
    for (const requirement of layoutRequirements.get(layoutId) ?? []) {
      if (paneId === requirement.pluginId || paneId.startsWith(`${requirement.pluginId}:`) || paneId.startsWith(`${requirement.pluginId}-`)) {
        return requirement;
      }
    }
  }
  return null;
}

function MissingPanePlaceholder({ paneType, width }: PaneProps) {
  const layouts = useAppSelector((state) => state.config.layouts);
  const activeIndex = useAppSelector((state) => state.config.activeLayoutIndex);
  const linkedIds = [layouts[activeIndex]?.origin?.layoutId, ...layouts.map((layout) => layout.origin?.layoutId)]
    .filter((id): id is string => !!id);
  const requirement = requirementFor(paneType, linkedIds);
  const installer = canInstallPlugins() ? getPluginManager() : null;
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const install = useCallback(() => {
    if (!installer || !requirement?.repo || installing) return;
    setInstalling(true);
    setError(null);
    void installer.install(requirement.repo).then((result) => {
      setInstalling(false);
      if (!result.ok) setError(result.error);
    });
  }, [installer, installing, requirement]);

  const pluginLabel = requirement?.pluginId ?? paneType.split(/[:\-]/)[0] ?? paneType;
  const message = canInstallPlugins()
    ? requirement?.repo
      ? `A teammate's pane from ${pluginLabel}. Install the plugin to see it.`
      : `A teammate's pane from ${pluginLabel}. Install the plugin with PL to see it.`
    : `A teammate's pane from ${pluginLabel}. Plugins are not available on the web.`;

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1} width={width}>
      <EmptyState
        title={`${pluginLabel} is not installed`}
        message={message}
        hint={error ?? "Publishing from here keeps this pane for the rest of the team."}
        status={error ? "error" : "empty"}
        actions={installer && requirement?.repo ? (
          <Button
            label={installing ? "Installing..." : `Install ${pluginLabel}`}
            variant="primary"
            compact
            onPress={install}
            disabled={installing}
          />
        ) : undefined}
      />
    </Box>
  );
}

const placeholders = new Map<string, PaneDef>();

/**
 * A pane definition standing in for one this terminal does not have. The
 * instance config passes through untouched, so a layout published from here
 * still carries the pane for teammates who do have the plugin.
 */
export function missingPanePlaceholderDef(paneId: string): PaneDef {
  let def = placeholders.get(paneId);
  if (!def) {
    def = {
      id: paneId,
      name: paneId,
      icon: "?",
      component: MissingPanePlaceholder,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 60, height: 12 },
      portableShare: { private: {} },
    };
    placeholders.set(paneId, def);
  }
  return def;
}

export function isMissingPanePlaceholder(def: PaneDef): boolean {
  return placeholders.get(def.id) === def;
}
