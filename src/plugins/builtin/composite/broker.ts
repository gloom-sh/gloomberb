import { composeBuiltinPlugin } from "../plugin-module";
import { brokerManagerModule } from "../broker-manager";
import { brokerTradingModule } from "../broker-trading";

export const brokerPlugin = composeBuiltinPlugin({
  id: "broker",
  name: "Broker",
  version: "1.0.0",
  description: "Broker profiles, account sync, order review, and trading status.",
  toggleable: true,
  modules: [brokerManagerModule, brokerTradingModule],
});
