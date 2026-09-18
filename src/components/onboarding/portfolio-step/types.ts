import type { RefObject } from "react";
import type { InputRenderable } from "../../../ui";
import type { BrokerConfigField } from "../../../types/broker";
import type { ListViewItem } from "../../ui";
import type { OnboardingPositionsState } from "../wizard-positions";

/** `positions` is the manual entry form; the rest is the optional broker import. */
export type PortfolioSub = "positions" | "choose" | "broker-setup" | "broker-fields" | "broker-sync";

export interface PortfolioStepProps {
  sub: PortfolioSub;
  positions: OnboardingPositionsState;
  positionsInputRef: RefObject<InputRenderable | null>;
  positionsEditing: boolean;
  commandBarShortcut: string;
  choices: ListViewItem[];
  optionIdx: number;
  onOptionSelect: (idx: number) => void;
  onOptionActivate: (idx: number) => void;
  selectedBrokerId: string | null;
  brokerFields: BrokerConfigField[];
  brokerFieldIdx: number;
  brokerSelectIdx: number;
  onBrokerSelect?: (index: number) => void;
  brokerValues: Record<string, Record<string, string>>;
  onBrokerFieldChange: (brokerId: string, key: string, value: string) => void;
  onSubmitBrokerField?: () => void;
  editing: boolean;
  inputRef: RefObject<InputRenderable | null>;
  brokerSyncing: boolean;
  brokerSyncError: string | null;
}
