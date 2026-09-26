import { createDefaultConfig } from "../types/config";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../types/headless";
import type { PaneTemplateContext } from "../types/plugin";
import { createTestDataProvider } from "./data-provider";

/** Load args with no argument, symbols or options; pass the ones the pane reads. */
export function createTestHeadlessArgs(overrides: Partial<HeadlessPaneLoadArgs> = {}): HeadlessPaneLoadArgs {
  return { rawArgument: "", argument: null, symbols: [], options: {}, ...overrides };
}

/** A headless load context on a test data provider, an empty API client and a default config. */
export function createTestHeadlessContext(overrides: Partial<HeadlessPaneContext> = {}): HeadlessPaneContext {
  return {
    marketData: createTestDataProvider(),
    apiClient: {} as HeadlessPaneContext["apiClient"],
    config: createDefaultConfig("/tmp/gloomberb-headless-test"),
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** A template context with an empty layout and nothing focused or active. */
export function createTestTemplateContext(overrides: Partial<PaneTemplateContext> = {}): PaneTemplateContext {
  return {
    config: {} as PaneTemplateContext["config"],
    layout: { dockRoot: null, instances: [], floating: [], detached: [] },
    focusedPaneId: null,
    activeTicker: null,
    activeCollectionId: null,
    ...overrides,
  };
}
