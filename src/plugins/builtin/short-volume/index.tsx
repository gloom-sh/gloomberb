import type { PaneInstanceConfig } from "../../../types/config";
import type { PluginModule } from "../plugin-module";
import { SHORT_VOLUME_SERIES } from "./series";
import { shortVolumeCache } from "./client";

export const shortVolumeSettings = [
  { key: "shortVolumeScope", label: "Reporting scope", type: "select" as const,
    options: [{ value: "nms", label: "NMS off-exchange" }, { value: "otc", label: "OTC Reporting Facility" }] },
  { key: "finraSymbol", label: "FINRA symbol override", type: "text" as const, placeholder: "Exact source identity, e.g. ABRpD" },
];
/** A FINRA symbol override names one security, so that pane cannot follow a list. */
export const followsWithoutFinraOverride = (pane: PaneInstanceConfig) => (
  typeof pane.settings?.finraSymbol !== "string" || !pane.settings.finraSymbol.trim()
);
/** The daily-volume cache. `SIV` opens the short interest pane, so this module has no pane of its own. */
export const shortVolumeModule: PluginModule = {
  series: SHORT_VOLUME_SERIES,
  setup(ctx) { shortVolumeCache.attach(ctx.persistence); },
  dispose() { shortVolumeCache.reset(); },
};
