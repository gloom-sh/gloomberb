import type { RefObject } from "react";
import type { InputRenderable } from "../../../ui";
import type { BrokerConfigField } from "../../../types/broker";
import type { ListViewItem } from "../../ui";

export type PortfolioSub = "choose" | "broker-setup" | "broker-fields" | "broker-sync";

export interface PortfolioStepProps {
  sub: PortfolioSub;
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
