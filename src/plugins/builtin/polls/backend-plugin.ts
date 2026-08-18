import { composeBuiltinPlugin } from "../plugin-module";

export const pollsBackendPlugin = composeBuiltinPlugin({
  id: "polls",
  name: "Polls",
  version: "1.0.0",
  description: "Political polls from VoteHub (CC BY 4.0)",
  toggleable: true,
  modules: [],
});
