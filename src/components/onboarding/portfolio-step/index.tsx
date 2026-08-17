import { BrokerFieldsPanel } from "./broker-fields-panel";
import { BrokerSetupPanel } from "./broker-setup-panel";
import { BrokerSyncPanel } from "./broker-sync-panel";
import { PortfolioChoicePanel } from "./choose-panel";
import type { PortfolioStepProps, PortfolioSub } from "./types";

export type { PortfolioSub };

export function PortfolioStep(props: PortfolioStepProps) {
  if (props.sub === "choose") {
    return (
      <PortfolioChoicePanel
        choices={props.choices}
        optionIdx={props.optionIdx}
        onOptionSelect={props.onOptionSelect}
        onOptionActivate={props.onOptionActivate}
      />
    );
  }

  if (props.sub === "broker-setup" && props.selectedBrokerId) {
    return (
      <BrokerSetupPanel
        choices={props.choices}
        selectedBrokerId={props.selectedBrokerId}
        brokerValues={props.brokerValues}
      />
    );
  }

  if (props.sub === "broker-sync" && props.selectedBrokerId) {
    return (
      <BrokerSyncPanel
        choices={props.choices}
        selectedBrokerId={props.selectedBrokerId}
        brokerSyncing={props.brokerSyncing}
        brokerSyncError={props.brokerSyncError}
      />
    );
  }

  if (!props.selectedBrokerId) {
    return null;
  }

  return (
    <BrokerFieldsPanel
      choices={props.choices}
      selectedBrokerId={props.selectedBrokerId}
      brokerFields={props.brokerFields}
      brokerFieldIdx={props.brokerFieldIdx}
      brokerSelectIdx={props.brokerSelectIdx}
      onBrokerSelect={props.onBrokerSelect}
      brokerValues={props.brokerValues}
      onBrokerFieldChange={props.onBrokerFieldChange}
      onSubmitBrokerField={props.onSubmitBrokerField}
      editing={props.editing}
      inputRef={props.inputRef}
    />
  );
}
