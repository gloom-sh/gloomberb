import { useMemo } from "react";
import { useAppSelector, usePaneInstance } from "../../../state/app/context";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";
import { usePluginPaneState } from "../../../public/react";
import type { PaneInstanceConfig } from "../../../types/config";
import { parseLayerTokens, LAYERS_SETTING_KEY } from "./layers";
import { isLocalGeoLayer, type GeoScope } from "./local-layers";

/**
 * Pane state a ticker source may publish beside `cursorSymbol`: the group the
 * selected company belongs to, which a linked map can widen to. TheBuildout
 * publishes the theme its table lists.
 */
export const GEO_SCOPE_STATE_KEY = "geoScope";

type GeoScopeMode = "company" | "theme";

function publishedScope(value: unknown): GeoScope | null {
  if (!value || typeof value !== "object") return null;
  const { key, label } = value as Partial<GeoScope>;
  return typeof key === "string" && key && typeof label === "string" ? { key, label } : null;
}

/** A map with one of the app's own layers on can be linked to a list's or a scanner's selection. */
export function mapFollowsTicker(pane: PaneInstanceConfig): boolean {
  return parseLayerTokens(pane.settings?.[LAYERS_SETTING_KEY]).some(isLocalGeoLayer);
}

export interface LinkedGeoScope {
  /** What the map's own layers show; null shows everything. */
  scope: GeoScope | null;
  /** The company the link resolves to. */
  company: GeoScope | null;
  /** The group its source publishes for that company. */
  theme: GeoScope | null;
  mode: GeoScopeMode;
  setMode: (mode: GeoScopeMode) => void;
}

/**
 * What a linked map narrows its own layers to: the company the link resolves
 * to, or the theme its source publishes once the pane is switched to it (and
 * whenever there is no company). An unlinked map has neither and shows
 * everything.
 */
export function useLinkedGeoScope(enabled: boolean): LinkedGeoScope {
  const instance = usePaneInstance();
  const linked = enabled && (instance?.binding?.kind === "follow" || instance?.binding?.kind === "fixed");
  const sourceId = linked && instance?.binding?.kind === "follow" ? instance.binding.sourceInstanceId : null;
  const published = useAppSelector((state) => (sourceId ? state.paneState[sourceId]?.[GEO_SCOPE_STATE_KEY] ?? null : null));
  const { symbol } = usePaneTickerIdentity();
  const [mode, setMode] = usePluginPaneState<GeoScopeMode>("geoScopeMode", "company");
  const theme = linked ? publishedScope(published) : null;
  const companySymbol = linked ? symbol : null;
  const themeKey = theme?.key ?? null;
  const themeLabel = theme?.label ?? "";
  return useMemo(() => {
    const company = companySymbol ? { key: `company:${companySymbol}`, label: companySymbol } : null;
    const group = themeKey ? { key: themeKey, label: themeLabel } : null;
    const scope = mode === "theme" ? group ?? company : company ?? group;
    return { scope, company, theme: group, mode, setMode };
  }, [companySymbol, mode, setMode, themeKey, themeLabel]);
}
