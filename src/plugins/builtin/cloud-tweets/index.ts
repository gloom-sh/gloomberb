import type { PluginModule } from "../plugin-module";
import { registerTwitterFeedFeature } from "./registration";

export const cloudTweetsModule: PluginModule = {
  setup: registerTwitterFeedFeature,
};
