import { useCallback, useState } from "react";
import { Button } from "../ui/button";
import { confirmDialog } from "../ui/confirm-dialog";
import { EmptyState } from "../ui/status";
import { runsExternalPlugins } from "../../plugins/current-target";
import { activateInstall } from "../../plugins/builtin/plugin-marketplace/activation";
import { installConsent } from "../../plugins/builtin/plugin-marketplace/model";
import { getMarketplaceHost, getPluginManager } from "../../plugins/builtin/plugin-marketplace/store";
import type { PaneDef, PaneProps } from "../../types/plugin";
import { Box } from "../../ui";
import { useOptionalDialog } from "../../ui/dialog";
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

/**
 * What the placeholder says. Pane ids are `<plugin>:<name>`, and a dash is part
 * of a name (`market-heatmap`), so only a layout requirement can name the
 * plugin behind a dashed id; without one the id is cut at the colon, or shown
 * whole when it has none.
 */
export function describeMissingPane({ paneType, requirement, fromTeam, canInstall, runsPlugins }: {
  paneType: string;
  requirement: LayoutRequirement | null;
  /** The pane arrived with a published team layout. */
  fromTeam: boolean;
  /** This renderer has a plugin manager registered and a dialog to confirm the install in. */
  canInstall: boolean;
  /** This renderer loads plugins that are not part of its build. The web terminal does not. */
  runsPlugins: boolean;
}): { pluginLabel: string; title: string; message: string; installable: boolean } {
  const pluginLabel = requirement?.pluginId ?? (paneType.split(":")[0] || paneType);
  const source = fromTeam
    ? `A teammate's pane from ${pluginLabel}.`
    : `This pane comes from the ${pluginLabel} plugin.`;
  const installable = canInstall && !!requirement?.repo;
  const action = installable
    ? "Install the plugin to see it."
    : canInstall || runsPlugins
      ? "Install the plugin with PL to see it."
      : "Plugins are not available on the web.";
  return { pluginLabel, title: `${pluginLabel} is not installed`, message: `${source} ${action}`, installable };
}

function MissingPanePlaceholder({ paneType, width }: PaneProps) {
  const layouts = useAppSelector((state) => state.config.layouts);
  const activeIndex = useAppSelector((state) => state.config.activeLayoutIndex);
  const linkedIds = [layouts[activeIndex]?.origin?.layoutId, ...layouts.map((layout) => layout.origin?.layoutId)]
    .filter((id): id is string => !!id);
  const requirement = requirementFor(paneType, linkedIds);
  // The renderers that can run git and bun register a manager at startup: the
  // terminal itself, and the desktop view through its Bun process. The web
  // terminal leaves it unset.
  const installer = getPluginManager();
  // An install runs the plugin with full permissions, so it is never started
  // without asking; where no dialog can be shown it is not offered at all.
  const dialog = useOptionalDialog();
  const { pluginLabel, title, message, installable } = describeMissingPane({
    paneType,
    requirement,
    fromTeam: !!requirement || !!layouts[activeIndex]?.origin,
    canInstall: !!installer && !!dialog,
    runsPlugins: runsExternalPlugins(),
  });
  const [installing, setInstalling] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);

  // The terminal's default dialog is 60 columns, 54 inside its border and
  // padding; a wider body runs over the border.
  const confirmWidth = Math.min(54, Math.max(44, width - 8));
  const repo = requirement?.repo;
  const install = useCallback(async () => {
    if (!installer || !dialog || !repo || installing) return;
    // The repo comes from a team layout, not from a catalog Gloom reviewed.
    const consent = installConsent({ name: pluginLabel, tier: "community", hosts: [], repo }, undefined);
    const confirmed = await confirmDialog(dialog, {
      title: consent.title,
      body: consent.body,
      confirmLabel: "Install",
      confirmVariant: "primary",
      width: confirmWidth,
    });
    if (!confirmed) return;
    setInstalling(true);
    setNotice(null);
    try {
      const result = await installer.install(repo);
      if (!result.ok) {
        setNotice({ text: result.error, error: true });
        return;
      }
      // Bring it into this session so the pane replaces the placeholder rather
      // than waiting for a restart; a plugin that cannot load live says so.
      const host = getMarketplaceHost();
      const activated = host ? await activateInstall(result, host, installer) : null;
      if (activated && !activated.ok) setNotice({ text: `Installed but did not load: ${activated.error}`, error: true });
      else if (!activated || activated.restart) setNotice({ text: "Installed. Restart to finish.", error: false });
    } finally {
      setInstalling(false);
    }
  }, [confirmWidth, dialog, installer, installing, pluginLabel, repo]);

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1} width={width}>
      <EmptyState
        title={title}
        message={message}
        hint={notice?.text ?? "Publishing from here keeps this pane for the rest of the team."}
        status={notice?.error ? "error" : "empty"}
        actions={installable ? (
          <Button
            label={installing ? "Installing..." : `Install ${pluginLabel}`}
            variant="primary"
            compact
            onPress={() => { void install(); }}
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
