import type { BrokerAdapter } from "../types/broker";

/** The minimum a BrokerAdapter must implement; a test overrides only the calls it exercises. */
export function createTestBrokerAdapter(overrides: Partial<BrokerAdapter> = {}): BrokerAdapter {
  return {
    id: "test-broker",
    name: "Test Broker",
    configSchema: [],
    validate: async () => true,
    importPositions: async () => [],
    ...overrides,
  };
}
