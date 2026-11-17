import type { PluginModule } from "../plugin-module";

// Ticker Research's modules are drawn in the renderer: the desktop backend
// process runs none of them, and keeps only the identity of the plugins that
// hold nothing else.
export const rendererOnly = (module: PluginModule) => ({ module, rendererOnly: true });
export const tickerResearchModule = (module: PluginModule) => ({ module, stateId: "ticker-research", rendererOnly: true });
export const runtimeOnly = (module: PluginModule): PluginModule => {
  const { panes: _panes, paneTemplates: _paneTemplates, ...runtime } = module;
  return runtime;
};
