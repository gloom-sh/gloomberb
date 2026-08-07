import type { BrokerAdapter } from "../../types/broker";

export type OnboardingStep = "welcome" | "theme" | "portfolio" | "shortcuts" | "account" | "ready";

export const ONBOARDING_STEPS: OnboardingStep[] = ["welcome", "theme", "portfolio", "shortcuts", "account", "ready"];

export interface BrokerOption {
  id: string;
  name: string;
  adapter: BrokerAdapter;
}

export function getConnectableBrokerOptions(brokers: Iterable<[string, BrokerAdapter]>): BrokerOption[] {
  const options: BrokerOption[] = [];
  for (const [id, adapter] of brokers) {
    if (adapter.configSchema.length > 0) {
      options.push({ id, name: adapter.name, adapter });
    }
  }
  return options;
}
