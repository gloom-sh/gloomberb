import type { GloomPlugin } from "../../types/plugin";
import { ibkrBroker } from "./broker-adapter";

/**
 * Interactive Brokers account sync over the Flex Web Service.
 *
 * This half owns the broker id and the profile schema, including the Gateway
 * fields, so a user has one "Interactive Brokers" profile regardless of which
 * connection mode it uses and existing saved credentials keep working.
 *
 * Flex is plain HTTPS against a hosted statement service. The Gateway half needs
 * a TCP socket to a local TWS process, so it ships separately as `ibkr-gateway`
 * and registers itself through `gateway-bridge`. With it absent, a Gateway-mode
 * profile explains that rather than failing obscurely.
 */
export const ibkrPlugin: GloomPlugin = {
  id: "ibkr",
  name: "Interactive Brokers",
  version: "1.0.0",
  description: "Interactive Brokers account and position sync through the Flex Web Service.",
  homepage: "https://github.com/gloom-sh/gloomberb-ibkr",
  toggleable: true,
  broker: ibkrBroker,

  setup(ctx) {
    ctx.log.info("IBKR plugin initializing");
  },
};

export default ibkrPlugin;
