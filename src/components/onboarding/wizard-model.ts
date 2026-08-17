import type { BrokerAdapter } from "../../types/broker";
import type { AppConfig, OnboardingProgress } from "../../types/config";

export function getOnboardingProgress(config: AppConfig): OnboardingProgress {
  return config.onboardingProgress ?? { version: 1, stage: "welcome" };
}

export function withOnboardingProgress(
  config: AppConfig,
  patch: Partial<OnboardingProgress> & Pick<OnboardingProgress, "stage">,
): AppConfig {
  return {
    ...config,
    onboardingComplete: false,
    onboardingProgress: {
      ...getOnboardingProgress(config),
      ...patch,
      version: 1,
    },
  };
}

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
