import { composeBuiltinPlugin } from "../plugin-module";
import { rendererOnly } from "./shared";
import { attentionModule } from "../attention";
import { awardsModule } from "../awards";
import { altDataPluginMeta } from "../builtin-plugin-meta";
import { companyAttentionModule } from "../company-attention";
import { exposureModule } from "../exposure";
import { gpuModule } from "../gpu";
import { jobsModule } from "../jobs";
import { powerModule } from "../power";
import { socialMentionsModule } from "../social-mentions";
import { supplyChainModule } from "../supply-chain";

export const altDataPlugin = composeBuiltinPlugin({
  ...altDataPluginMeta,
  modules: [
    ...[attentionModule, gpuModule, powerModule].map((module) => ({ module, stateId: "market-overview" })),
    ...[supplyChainModule, exposureModule, awardsModule, companyAttentionModule, jobsModule, socialMentionsModule].map(rendererOnly),
  ],
});
