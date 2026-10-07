import type { PluginModule } from "../plugin-module";
import { gpuBoardCache, gpuEventsCache, gpuHistoryCache } from "./client";
import { gpuHeadless } from "./headless";
import { GPU_MODELS, gpuArgument } from "./model";
import { GpuPane } from "./pane";

export const gpuModule: PluginModule = {
  panes: [{ id: "gpu", name: "GPU Rental Prices", icon: "G", component: GpuPane, defaultPosition: "right", defaultMode: "floating",
    defaultFloatingSize: { width: 120, height: 34 }, tableExport: true, headless: gpuHeadless }],
  paneTemplates: [{ id: "gpu-pane", paneId: "gpu", label: "GPU Rental Prices",
    description: "Pro GPU rental list prices, provider-declared spot and marketplace asks, with sourced price history and related equities. Free preview available.",
    keywords: ["gpu", "h100", "h200", "b200", "gb200", "compute", "rental", "neocloud", "hourly"],
    shortcut: { prefix: "GPU", argKind: "text", argPlaceholder: "GPU", argOptional: true,
      argOptions: () => GPU_MODELS.map((value) => ({ value, label: value })) }, headless: gpuHeadless,
    createInstance: (_context, options) => ({ placement: "floating", params: { gpuModel: gpuArgument(options?.arg) } }) }],
  setup(ctx) { for (const cache of [gpuBoardCache, gpuHistoryCache, gpuEventsCache]) cache.attach(ctx.persistence); },
  dispose() { for (const cache of [gpuBoardCache, gpuHistoryCache, gpuEventsCache]) cache.reset(); },
};
